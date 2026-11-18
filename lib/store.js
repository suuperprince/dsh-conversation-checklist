/**
 * Per-conversation persistence.
 *
 * One JSON file per Session id. A Session's checklist can therefore never be
 * read into, or written from, another Session's document: the file name is the
 * whole ownership boundary.
 *
 * Writes are atomic (temp file + rename) and are serialized through a per-file
 * chain, so a reconnect or a retry that re-sends the same event cannot interleave
 * two writers over one document.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SCHEMA_VERSION = 2

const fileName = (sessionId) => `${encodeURIComponent(String(sessionId))}.json`

export function createStore(rootDir) {
  const chains = new Map()

  const pathOf = (sessionId) => join(rootDir, fileName(sessionId))

  async function ensureDir() {
    await mkdir(rootDir, { recursive: true })
  }

  function serialize(sessionId, task) {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the chain alive without leaking an unhandled rejection.
    chains.set(sessionId, next.catch(() => {}))
    return next
  }

  return {
    rootDir,

    /** @returns {Promise<object|null>} the stored document, or null when absent/unreadable. */
    /** Session ids that have a stored document (ignores migration backups). */
    async list() {
      let names = []
      try { names = await readdir(rootDir) } catch { return [] }
      return names
        .filter((n) => n.endsWith('.json') && !/\.(?:before-|corrupt-|stale-)/.test(n))
        .map((n) => decodeURIComponent(n.slice(0, -5)))
    },

    async load(sessionId) {
      const file = pathOf(sessionId)
      let raw
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
      let doc
      try {
        doc = JSON.parse(raw)
      } catch {
        // Fail closed: keep the unreadable bytes for the user, never guess.
        await rename(file, `${file}.corrupt-${Date.now()}`)
        return null
      }
      if (!doc || doc.version !== SCHEMA_VERSION || doc.sessionId !== String(sessionId) || !Array.isArray(doc.tasks)) {
        await writeFile(`${file}.stale-${Date.now()}`, raw).catch(() => {})
        return null
      }
      return doc
    },

    async backup(sessionId, doc) {
      await ensureDir()
      const file = pathOf(sessionId) + '.before-extractor-' + String(doc.extractorVersion ?? 0) + '.json'
      try {
        await writeFile(file, JSON.stringify(doc, null, 2), { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    },

    save(sessionId, doc) {
      return serialize(sessionId, async () => {
        await ensureDir()
        const file = pathOf(sessionId)
        const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        await writeFile(temp, JSON.stringify(doc, null, 2), 'utf8')
        await rename(temp, file)
      })
    },

    /** Wait for every queued write of this Session to reach the disk. */
    async drain(sessionId) {
      await (chains.get(sessionId) ?? Promise.resolve())
    },
  }
}
