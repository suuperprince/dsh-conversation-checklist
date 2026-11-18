/**
 * Host wiring: real `apply()` against a stand-in Cordis context.
 *
 * This exercises the layer DSH actually calls — the session/event listener, the
 * HTTP routes, and persistence across a simulated restart — not the engine alone.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fakeContext(services = {}) {
  const handlers = new Map()
  const routes = new Map()
  const disposers = []
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, handlers, routes, dispose: () => disposers.forEach((fn) => fn()) }
}

function fakeSession(id, events = []) {
  const log = [...events]
  return {
    id,
    header: {},
    log,
    snapshotEvents: (from = 0, to = log.length) => log.slice(from, to),
  }
}

function event(type, seq, data) {
  return { type, seq, time: Date.now(), data }
}

const userMessage = (text, seq) =>
  event('user/message', seq, { role: 'user', content: [{ type: 'text', text }] })
const assistantMessage = (text, seq) =>
  event('assistant/message', seq, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    stream: [],
  })

function fakeRes() {
  const chunks = []
  return {
    chunks,
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers ?? {})
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      this.ended = true
    },
    json() {
      const body = chunks.join('')
      return JSON.parse(body.slice(body.indexOf('{')) || '{}')
    },
    frames() {
      return chunks
        .join('')
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map((block) => JSON.parse(block.slice(6)))
    },
  }
}

function fakeReq(url, { method = 'GET', body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** The hierarchy a reader sees: children under their parent, in task order. */
function treeOf(checklist, parentId = null, depth = 0) {
  const lines = []
  for (const task of checklist.tasks) {
    if (task.parentId !== parentId) continue
    if (task.status === 'dismissed') continue
    lines.push(`${'  '.repeat(depth)}${task.text} [${task.status}]`)
    lines.push(...treeOf(checklist, task.id, depth + 1))
  }
  return lines
}

const stateUrl = (sessionId) => `/api/dsh-conversation-checklist/state?sessionId=${encodeURIComponent(sessionId)}`

async function callState(routes, sessionId) {
  const res = fakeRes()
  await routes.get('/api/dsh-conversation-checklist/state')(fakeReq(stateUrl(sessionId)), res)
  return res.json()
}

async function callAction(routes, body) {
  const res = fakeRes()
  await routes.get('/api/dsh-conversation-checklist/action')(fakeReq('/api/dsh-conversation-checklist/action', { method: 'POST', body }), res)
  return res.json()
}

/** DSH commits the event, then dispatches the feed: model that order. */
async function emit(handlers, session, ev) {
  if (session.log) session.log.push(ev)
  handlers.get('session/event')(session, ev)
  await tick()
}

test('events on the live feed build the checklist without any refresh', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, handlers, routes } = fakeContext()
  apply(ctx, { dataDir })

  const session = fakeSession('session-a')
  await emit(handlers, session, userMessage('Install DSH on my iPad.', 1))
  await emit(handlers, session, assistantMessage('The app needs signing before it can be installed.', 2))
  await emit(handlers, session, userMessage('Also back up my DSH settings.', 3))
  await emit(handlers, session, userMessage('Signing is done, but installation is blocked until I register the iPad.', 4))

  const state = await callState(routes, 'session-a')
  assert.equal(state.ok, true)
  assert.deepEqual(treeOf(state.checklist), [
    'Install DSH on my iPad [blocked]',
    '  Signing [done]',
    '  Register the iPad [todo]',
    'Back up my DSH settings [todo]',
  ])
  const blocked = state.checklist.tasks.find((t) => t.text === 'Install DSH on my iPad')
  assert.equal(blocked.blockedBy, 'Register the iPad')
})

test('the open stream receives a frame for each change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, handlers, routes } = fakeContext()
  apply(ctx, { dataDir })

  const session = fakeSession('session-a')
  const res = fakeRes()
  routes.get('/api/dsh-conversation-checklist/stream')(fakeReq('/api/dsh-conversation-checklist/stream?sessionId=session-a'), res)
  await tick()
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)

  await emit(handlers, session, userMessage('Install DSH on my iPad.', 1))
  const frames = res.frames()
  assert.ok(frames.length >= 2, 'initial frame plus the update')
  const last = frames[frames.length - 1]
  assert.equal(last.tasks.length, 1)
  assert.equal(last.counts.open, 1, 'the badge count the sidebar shows')
})

test('a retried event does not duplicate a task', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, handlers, routes } = fakeContext()
  apply(ctx, { dataDir })
  const session = fakeSession('session-a')

  const first = userMessage('Install DSH on my iPad.', 1)
  await emit(handlers, session, first)
  await emit(handlers, session, first)
  await emit(handlers, session, userMessage('Install DSH on my iPad.', 1))

  const state = await callState(routes, 'session-a')
  assert.equal(state.checklist.tasks.length, 1)
})

test('conversations stay separate and a restart restores both', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const first = fakeContext()
  apply(first.ctx, { dataDir })
  await emit(first.handlers, fakeSession('session-a'), userMessage('Install DSH on my iPad.', 1))
  await emit(first.handlers, fakeSession('session-b'), userMessage('Write the quarterly report.', 1))

  const a = await callState(first.routes, 'session-a')
  const b = await callState(first.routes, 'session-b')
  assert.deepEqual(a.checklist.tasks.map((t) => t.text), ['Install DSH on my iPad'])
  assert.deepEqual(b.checklist.tasks.map((t) => t.text), ['Write the quarterly report'])

  // Simulated restart: a fresh plugin instance over the same data directory.
  const second = fakeContext()
  apply(second.ctx, { dataDir })
  const restoredA = await callState(second.routes, 'session-a')
  const restoredB = await callState(second.routes, 'session-b')
  assert.deepEqual(restoredA.checklist.tasks.map((t) => t.text), ['Install DSH on my iPad'])
  assert.deepEqual(restoredB.checklist.tasks.map((t) => t.text), ['Write the quarterly report'])
  assert.equal(restoredA.checklist.tasks[0].id, a.checklist.tasks[0].id, 'stable id across restart')
})

test('a manual rename survives later syncs and a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const first = fakeContext()
  apply(first.ctx, { dataDir })
  const session = fakeSession('session-a')
  await emit(first.handlers, session, userMessage('Install DSH on my iPad.', 1))

  const state = await callState(first.routes, 'session-a')
  const id = state.checklist.tasks[0].id
  const renamed = await callAction(first.routes, { sessionId: 'session-a', kind: 'rename', id, text: 'Get DSH onto the iPad' })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.checklist.tasks[0].text, 'Get DSH onto the iPad')

  await emit(first.handlers, session, assistantMessage('The app needs signing.', 2))
  await emit(first.handlers, session, userMessage('Install DSH on my iPad.', 3))

  const second = fakeContext()
  apply(second.ctx, { dataDir })
  const restored = await callState(second.routes, 'session-a')
  const install = restored.checklist.tasks.find((t) => t.id === id)
  assert.equal(install.text, 'Get DSH onto the iPad', 'manual edit kept')
  assert.equal(restored.checklist.tasks.filter((t) => /DSH onto|Install DSH on my iPad/.test(t.text)).length, 1)
})

test('a conversation that already ran is analyzed on first sight (backfill)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, handlers, routes } = fakeContext()
  apply(ctx, { dataDir })

  const history = [
    userMessage('Install DSH on my iPad.', 1),
    assistantMessage('The app needs signing before it can be installed.', 2),
    userMessage('Also back up my DSH settings.', 3),
  ]
  const session = fakeSession('session-a', [...history])
  history.push(userMessage('Signing is done.', 4))
  await emit(handlers, session, history[history.length - 1])

  const state = await callState(routes, 'session-a')
  assert.deepEqual(
    state.checklist.tasks.map((t) => t.text),
    ['Install DSH on my iPad', 'Signing', 'Back up my DSH settings'],
    'the whole conversation, not just the latest message',
  )
})

test('tracking can be turned off and on per conversation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, handlers, routes } = fakeContext()
  apply(ctx, { dataDir })
  const session = fakeSession('session-a')
  await emit(handlers, session, userMessage('Install DSH on my iPad.', 1))

  await callAction(routes, { sessionId: 'session-a', kind: 'set-tracking', tracking: false })
  await emit(handlers, session, userMessage('Also back up my DSH settings.', 2))
  let state = await callState(routes, 'session-a')
  assert.equal(state.checklist.tracking, false)
  assert.deepEqual(state.checklist.tasks.map((t) => t.text), ['Install DSH on my iPad'])

  await callAction(routes, { sessionId: 'session-a', kind: 'set-tracking', tracking: true })
  await emit(handlers, session, userMessage('Deploy the release.', 3))
  state = await callState(routes, 'session-a')
  assert.ok(state.checklist.tasks.some((t) => /Deploy the release/.test(t.text)))
})

test('model extraction is opt-in, uses the configured route, and falls back', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      return (async function* once() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ ops: [{ op: 'add', text: 'Model-derived task', parent: null }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { ctx, handlers, routes } = fakeContext({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  })
  apply(ctx, { dataDir, extraction: 'model' })
  const session = fakeSession('session-a')
  await emit(handlers, session, userMessage('Install DSH on my iPad.', 1))
  // A finalized turn is the trigger; the model never sits in front of the reply.
  await emit(handlers, session, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))

  assert.equal(calls.length, 1, 'one call')
  assert.equal(calls[0].provider, 'deepseek-official')
  assert.ok(calls[0].messages[0].content[0].text.includes('Install DSH on my iPad'), 'only the relevant text')
  const state = await callState(routes, 'session-a')
  assert.ok(state.checklist.tasks.some((t) => t.text === 'Model-derived task'))

  // A failing route must not lose the deterministic result.
  const broken = fakeContext({
    llm: {
      stream() {
        throw new Error('route down')
      },
    },
  })
  const dir2 = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  apply(broken.ctx, { dataDir: dir2, extraction: 'model', model: { provider: 'p', model: 'm' } })
  const s2 = fakeSession('session-b')
  await emit(broken.handlers, s2, userMessage('Install DSH on my iPad.', 1))
  await emit(broken.handlers, s2, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
  const fallback = await callState(broken.routes, 'session-b')
  assert.ok(fallback.checklist.tasks.some((t) => /Install DSH on my iPad/.test(t.text)), 'rules still ran')
})

test('routes require a session id and reject writes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const { ctx, routes } = fakeContext()
  apply(ctx, { dataDir })

  const noId = fakeRes()
  await routes.get('/api/dsh-conversation-checklist/state')(fakeReq('/api/dsh-conversation-checklist/state'), noId)
  assert.equal(noId.statusCode, 400)

  const wrongMethod = fakeRes()
  await routes.get('/api/dsh-conversation-checklist/action')(fakeReq('/api/dsh-conversation-checklist/action'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})

test('a slow analysis that finishes after a session switch updates only its own session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const llm = {
    stream() {
      return (async function* slow() {
        await gate
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ ops: [{ op: 'add', text: 'Register the iPad', parent: null }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { ctx, handlers, routes } = fakeContext({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(ctx, { dataDir, extraction: 'model' })

  const a = fakeSession('session-a')
  await emit(handlers, a, userMessage('Install DSH on my iPad.', 1))
  const turnEnd = emit(handlers, a, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))

  // The user switches to Chat B while A's analysis is still running.
  const b = fakeSession('session-b')
  await emit(handlers, b, userMessage('Write the quarterly report.', 1))
  const before = await callState(routes, 'session-b')
  assert.deepEqual(before.checklist.tasks.map((t) => t.text), ['Write the quarterly report'])

  release()
  await turnEnd
  await tick()

  const afterB = await callState(routes, 'session-b')
  assert.deepEqual(
    afterB.checklist.tasks.map((t) => t.text),
    ['Write the quarterly report'],
    "A's late result never reaches B",
  )
  const afterA = await callState(routes, 'session-a')
  assert.ok(
    afterA.checklist.tasks.some((t) => t.text === 'Register the iPad'),
    "A's result lands in A",
  )
})

test('a rebuild during analysis discards the stale result', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const llm = {
    stream() {
      return (async function* slow() {
        await gate
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ ops: [{ op: 'add', text: 'Stale model task', parent: null }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const a = fakeSession('session-a')
  const { ctx, handlers, routes } = fakeContext({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    // A rebuild reads the conversation back out of the live session store.
    sessions: { get: (id) => (String(id) === 'session-a' ? a : undefined), list: () => [a] },
  })
  apply(ctx, { dataDir, extraction: 'model' })
  await emit(handlers, a, userMessage('Install DSH on my iPad.', 1))
  const turnEnd = emit(handlers, a, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))

  await callAction(routes, { sessionId: 'session-a', kind: 'rebuild' })
  release()
  await turnEnd
  await tick()

  const state = await callState(routes, 'session-a')
  assert.equal(
    state.checklist.tasks.some((t) => t.text === 'Stale model task'),
    false,
    'the replaced document is not resurrected',
  )
  assert.ok(state.checklist.tasks.some((t) => /Install DSH on my iPad/.test(t.text)))
})

test('the storage key is the session id, never the title or the open chat', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const first = fakeContext()
  apply(first.ctx, { dataDir })
  // Two conversations, same visible title and same workspace path.
  const a = fakeSession('session-same-title-a')
  const b = fakeSession('session-same-title-b')
  a.header = { cwd: '/Users/me/project', title: 'Untitled' }
  b.header = { cwd: '/Users/me/project', title: 'Untitled' }
  await emit(first.handlers, a, userMessage('Install DSH on my iPad.', 1))
  await emit(first.handlers, b, userMessage('Write the quarterly report.', 1))

  const stateA = await callState(first.routes, 'session-same-title-a')
  const stateB = await callState(first.routes, 'session-same-title-b')
  assert.deepEqual(stateA.checklist.tasks.map((t) => t.text), ['Install DSH on my iPad'])
  assert.deepEqual(stateB.checklist.tasks.map((t) => t.text), ['Write the quarterly report'])
})
