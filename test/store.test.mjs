/** Persistence: one file per conversation, atomic, replay-safe. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createDoc, ingestMessage } from '../lib/engine.js'

const tmp = () => mkdtemp(join(tmpdir(), 'ccl-store-'))

test('a document round-trips and stays bound to its conversation', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const doc = createDoc('session-a')
  ingestMessage(doc, { role: 'user', text: 'Install DSH on my iPad.', seq: 1 })
  await store.save('session-a', doc)

  const loaded = await store.load('session-a')
  assert.equal(loaded.sessionId, 'session-a')
  assert.equal(loaded.tasks[0].text, 'Install DSH on my iPad')

  assert.equal(await store.load('session-b'), null, 'another conversation reads nothing')
})

test('a document stored for one conversation is refused for another id', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const doc = createDoc('session-a')
  ingestMessage(doc, { role: 'user', text: 'Ship the release.', seq: 1 })
  await store.save('session-a', doc)

  // Same file, wrong id: the store must not hand it over.
  const { readFile: read } = await import('node:fs/promises')
  const raw = await read(join(dir, `${encodeURIComponent('session-a')}.json`), 'utf8')
  await writeFile(join(dir, `${encodeURIComponent('session-b')}.json`), raw)

  const stolen = await store.load('session-b')
  assert.equal(stolen, null, 'mismatched sessionId is rejected')
  const leftovers = await readdir(dir)
  assert.ok(leftovers.some((name) => name.startsWith(`${encodeURIComponent('session-b')}.json.stale-`)), 'kept for inspection')
})

test('a corrupt file fails closed and is preserved', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const file = join(dir, `${encodeURIComponent('session-x')}.json`)
  await writeFile(file, '{ not json', 'utf8')

  const loaded = await store.load('session-x')
  assert.equal(loaded, null)
  assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'unreadable bytes are not left in place')
  const entries = await readdir(dir)
  assert.equal(entries.filter((n) => n.includes('.corrupt-')).length, 1, 'preserved for the user')
})

test('concurrent writes for one conversation serialize to one intact file', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const doc = createDoc('session-c')
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    doc.sequence = index
    return store.save('session-c', doc)
  }))
  await store.drain('session-c')
  const loaded = await store.load('session-c')
  assert.ok(loaded !== null)
  assert.equal(loaded.version, 2)
  const leftovers = (await readdir(dir)).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'no temporary files left behind')
})
