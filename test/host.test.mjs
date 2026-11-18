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

test('conversation corrections survive later syncs and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const first = fakeContext()
  apply(first.ctx, { dataDir })
  const session = fakeSession('session-a')
  await emit(first.handlers, session, userMessage('Install DSH on my iPad.', 1))
  await emit(first.handlers, session, userMessage('Rename the iPad installation to Get DSH onto the iPad.', 2))
  first.dispose()
  const second = fakeContext(); apply(second.ctx, { dataDir })
  assert.equal((await callState(second.routes, 'session-a')).checklist.tasks[0].text, 'Get DSH onto the iPad')
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

test('the HTTP API rejects manual lifecycle controls and keeps tracking active', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const host = fakeContext(); apply(host.ctx, { dataDir })
  const session = fakeSession('session-a')
  await emit(host.handlers, session, userMessage('Install DSH on my iPad.', 1))
  const task = (await callState(host.routes, 'session-a')).checklist.tasks[0]
  for (const kind of ['dismiss','complete','reopen','rename','restore','accept-suggestion','dismiss-suggestion','set-tracking','rebuild']) {
    const result = await callAction(host.routes, {sessionId:'session-a', kind, id:task.id, tracking:false, text:'Changed'})
    assert.equal(result.ok, false)
    assert.equal(result.error, 'conversation-managed-checklist')
  }
  await emit(host.handlers, session, userMessage('Signing is done.', 2))
  const state = await callState(host.routes, 'session-a')
  assert.equal(state.checklist.tracking, true)
  assert.equal(state.checklist.tasks[0].text,task.text)
  assert.equal(state.checklist.tasks[0].status,'todo')
})

test('model extraction is opt-in, uses the configured route, and falls back', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccl-host-'))
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      return (async function* once() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ ops: [{ op: 'add', text: 'Verify model extraction', parent: null }] }) }
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
  assert.ok(state.checklist.tasks.some((t) => t.text === 'Verify model extraction'))

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

test('a real live tool result resolves its call and publishes completed status',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'ccl-live-proof-'))
 const host=fakeContext()
 apply(host.ctx,{dataDir})
 const a=fakeSession('proof-a')
 await emit(host.handlers,a,userMessage('Run the regression tests.',1))
 await emit(host.handlers,a,event('tool/call',2,{callId:'call-tests',name:'bash',arguments:JSON.stringify({command:'pytest tests/regression'})}))
 await emit(host.handlers,a,event('tool/result',3,{message:{role:'tool',toolCallId:'call-tests',isError:false,content:[{type:'text',text:'12 passed in 3.1s'}]}}))
 const state=await callState(host.routes,'proof-a')
 assert.equal(state.checklist.tasks[0].status,'done')
 assert.equal(state.checklist.tasks[0].completedBy.seq,3)
 assert.equal(state.checklist.tasks[0].completedBy.sessionId,'proof-a')
})

test('extractor upgrade backs up history and restores conversation ownership',async()=>{
 const {readFile,writeFile,readdir}=await import('node:fs/promises')
 const dataDir=await mkdtemp(join(tmpdir(),'ccl-migration-'))
 const a=fakeSession('migrate-a')
 const host=fakeContext({sessions:{get:()=>a}})
 apply(host.ctx,{dataDir})
 await emit(host.handlers,a,userMessage('Install DSH on my iPad.',1))
 const task=(await callState(host.routes,'migrate-a')).checklist.tasks[0]
 await callAction(host.routes,{sessionId:'migrate-a',kind:'rename',id:task.id,text:'My iPad setup'})
 await callAction(host.routes,{sessionId:'migrate-a',kind:'complete',id:task.id})
 host.dispose()
 const dir=join(dataDir,'dsh-conversation-checklist'),file=join(dir,'migrate-a.json')
 const doc=JSON.parse(await readFile(file,'utf8'))
 doc.tasks[0].manual={status:true,dismissed:true}
 doc.tasks[0].status='dismissed'
 doc.extractorVersion=2
 doc.tasks.push({...doc.tasks[0],id:'junk',text:'Until then',manual:{},parentId:null})
 await writeFile(file,JSON.stringify(doc))
 const next=fakeContext({sessions:{get:()=>a}})
 apply(next.ctx,{dataDir})
 const upgraded=(await callState(next.routes,'migrate-a')).checklist
 assert.equal(upgraded.tasks.length,1)
 assert.equal(upgraded.tasks[0].text,'Install DSH on my iPad')
 assert.equal(upgraded.tasks[0].status,'todo')
 assert.equal(upgraded.migrationPending,false)
 assert.ok((await readdir(dir)).some(name=>name.includes('before-extractor-2')))
 next.dispose()
})

test('history unavailable keeps the old document and reports migration pending',async()=>{
 const {readFile,writeFile}=await import('node:fs/promises')
 const dataDir=await mkdtemp(join(tmpdir(),'ccl-pending-'))
 const host=fakeContext()
 apply(host.ctx,{dataDir})
 await emit(host.handlers,fakeSession('old'),userMessage('Install DSH on my iPad.',1))
 host.dispose()
 const file=join(dataDir,'dsh-conversation-checklist','old.json')
 const old=JSON.parse(await readFile(file,'utf8'));old.extractorVersion=2
 await writeFile(file,JSON.stringify(old))
 const next=fakeContext();apply(next.ctx,{dataDir})
 const result=(await callState(next.routes,'old')).checklist
 assert.equal(result.tasks.length,1)
 assert.equal(result.migrationPending,true)
 next.dispose()
})

test('cold conversation history is loaded automatically through sessionQuery',async()=>{
 const {writeFile,mkdir}=await import('node:fs/promises')
 const dataDir=await mkdtemp(join(tmpdir(),'ccl-cold-'))
 const {createDoc}=await import('../lib/engine.js')
 const dir=join(dataDir,'dsh-conversation-checklist');await mkdir(dir)
 const old=createDoc('cold');old.extractorVersion=2
 old.tasks=[{id:'junk',parentId:null,text:'Until then',status:'todo',manual:{},sequence:1}]
 await writeFile(join(dir,'cold.json'),JSON.stringify(old))
 let disposed=false,reads=0
 const host=fakeContext({sessionQuery:{async observeSession(id,options){
  reads++;assert.equal(id,'cold');assert.equal(options.projectionMode,'none')
  return {header:{id},events:[userMessage('Run the regression tests.',0)], [Symbol.dispose](){disposed=true}}
 }}})
 apply(host.ctx,{dataDir})
 const state=await callState(host.routes,'cold')
 assert.equal(reads,1);assert.equal(disposed,true)
 assert.equal(state.checklist.migrationPending,false)
 assert.deepEqual(state.checklist.tasks.map(t=>t.text),['Run the regression tests'])
 host.dispose()
})

test('live PTC test execution checks off its own task',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'ccl-ptc-'))
 const host=fakeContext();apply(host.ctx,{dataDir});const a=fakeSession('ptc')
 await emit(host.handlers,a,userMessage('Run the regression tests.',0))
 const code = 'const r = await tools.bash({command: "cd app && .venv/bin/pytest tests/regression -q"}); console.log(r.stdout.text, r.stderr.text, r.exitCode);'
 await emit(host.handlers,a,event('tool/call',1,{callId:'ptc-test',name:'run_code',arguments:JSON.stringify({code})}))
 await emit(host.handlers,a,event('tool/result',2,{message:{role:'tool',toolCallId:'ptc-test',isError:false,content:[{type:'text',text:'12 passed in 2s\n 0'}]}}))
 assert.equal((await callState(host.routes,'ptc')).checklist.tasks[0].status,'done')
 host.dispose()
})

test('model mapping closes a task for a verified exit-0 command only', async () => {
  const run = async (tail) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ccl-map-'))
    const systems = []
    const llm = {
      stream(options) {
        const system = options.system ?? ''
        systems.push(system)
        let text = '{"ops":[]}'
        if (/match one finished shell command/.test(system)) {
          const body = options.messages[0].content[0].text
          const m = /^(\S+) ::/m.exec(body)
          text = JSON.stringify({ task: m ? m[1] : null })
        }
        return (async function* once() {
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { ctx, handlers, routes } = fakeContext({
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(ctx, { dataDir, extraction: 'model' })
    const session = fakeSession('session-map')
    await emit(handlers, session, userMessage('Start the phase0 compose stack.', 1))
    await emit(handlers, session, event('tool/call', 2, {
      turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'docker compose up -d' }),
    }))
    await emit(handlers, session, event('tool/result', 3, {
      turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: `up\n${tail}` }] },
    }))
    await emit(handlers, session, event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }))
    await tick()
    await tick()
    const state = await callState(routes, 'session-map')
    return { state, systems }
  }

  const ok = await run('[exit: 0 ]')
  const task = ok.state.checklist.tasks[0]
  assert.equal(task.status, 'done', 'mapping completed it')
  assert.match(task.completedBy.reason, /model mapped an exit-0 command/)
  assert.ok(ok.systems.some((s) => /match one finished shell command/.test(s)), 'mapping was asked')

  const bad = await run('[exit code: 1]')
  assert.equal(bad.state.checklist.tasks[0].status, 'todo', 'a failed command never maps')
  assert.equal(bad.systems.some((s) => /match one finished shell command/.test(s)), false, 'no mapping call without a success')
})
