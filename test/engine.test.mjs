/**
 * Engine behaviour. Expectations come from the acceptance scenario, not from
 * the implementation: the scenario is stated in prose, the assertions below
 * restate its observable requirements.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDoc, ingestMessage, applyManual, ingestNativePlan, ingestToolResult, successfulCommand, completeByMapping, project } from '../lib/engine.js'

/** Render the tree so a hierarchy assertion reads like the requirement. */
function tree(doc) {
  const p = project(doc)
  const byParent = new Map()
  for (const task of p.tasks) {
    if (!byParent.has(task.parentId)) byParent.set(task.parentId, [])
    byParent.get(task.parentId).push(task)
  }
  const lines = []
  const walk = (parentId, depth) => {
    for (const task of byParent.get(parentId) ?? []) {
      if (task.status === 'dismissed') continue
      lines.push(
        `${'  '.repeat(depth)}${task.text} [${task.status}]${task.blockedBy ? ` <- ${task.blockedBy}` : ''}`,
      )
      walk(task.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines
}

const say = (doc, role, text, seq) => ingestMessage(doc, { role, text, seq })
const applyManualStatusLock = (doc, id) => { const t = doc.tasks.find((x) => x.id === id); t.manual = { ...t.manual, status: true } }

/** The acceptance conversation, stated once so replay tests reuse the same input. */
const ACCEPTANCE = [
  ['user', 'Install DSH on my iPad.', 1],
  [
    'assistant',
    'The app needs signing before it can be installed. Next, you will need to provide your Apple developer certificate.',
    2,
  ],
  ['user', 'Also back up my DSH settings.', 3],
  ['user', 'Signing is done, but installation is blocked until I register the iPad.', 4],
]

function fold(events, passes = 1, sessionId = 'session-a') {
  const doc = createDoc(sessionId)
  for (let pass = 0; pass < passes; pass += 1) {
    for (const [role, text, seq] of events) say(doc, role, text, seq)
  }
  return doc
}

const scenario = () => fold(ACCEPTANCE)

test('acceptance: one parent task, sign-off attached, backup separate, blocker tracked', () => {
  const doc = createDoc('session-a')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  assert.deepEqual(tree(doc), ['Install DSH on my iPad [todo]'], 'step 1: one parent task')

  say(doc, 'assistant', 'The app needs signing before it can be installed.', 2)
  say(doc, 'user', 'Also back up my DSH settings.', 3)
  assert.deepEqual(
    tree(doc),
    ['Install DSH on my iPad [todo]', '  Signing [todo]', 'Back up my DSH settings [todo]'],
    'step 2: signing nested under installation, backup a separate top-level task',
  )

  say(doc, 'user', 'Signing is done, but installation is blocked until I register the iPad.', 4)
  assert.deepEqual(
    tree(doc),
    [
      'Install DSH on my iPad [blocked] <- Register the iPad',
      '  Signing [done]',
      '  Register the iPad [todo]',
      'Back up my DSH settings [todo]',
    ],
    'step 3: signing complete, registration under installation, installation blocked on it',
  )
})

test('acceptance: every task carries a stable id, parent, status and source reference', () => {
  const doc = scenario()
  const tasks = doc.tasks
  assert.ok(tasks.length >= 4)
  for (const task of tasks) {
    assert.match(task.id, /^t-[0-9a-f]{10}$/, 'stable content-derived id')
    assert.ok(task.parentId === null || tasks.some((t) => t.id === task.parentId), 'parent resolves')
    assert.ok(['todo', 'doing', 'blocked', 'done', 'dismissed'].includes(task.status))
    assert.match(String(task.sourceRef), /^seq:\d+$/, 'source message reference')
  }
  const signing = tasks.find((t) => t.text === 'Signing')
  assert.equal(signing.sourceRef, 'seq:2', 'the assistant turn that established it')
})

test('replay is idempotent: folding the same events twice adds nothing', () => {
  const once = fold(ACCEPTANCE, 1)
  const twice = fold(ACCEPTANCE, 3)
  const shape = (doc) => doc.tasks.map((t) => [t.id, t.text, t.status])
  assert.deepEqual(shape(twice), shape(once), 'three passes equal one pass')
})

test('conversations do not share a document', () => {
  const a = createDoc('session-a')
  const b = createDoc('session-b')
  say(a, 'user', 'Install DSH on my iPad.', 1)
  say(b, 'user', 'Write the quarterly report.', 1)
  assert.deepEqual(tree(a), ['Install DSH on my iPad [todo]'])
  assert.deepEqual(tree(b), ['Write the quarterly report [todo]'])
})

test('correction edits the existing task instead of adding one', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Deploy the staging build.', 1)
  say(doc, 'user', 'Actually, rename the staging build to production release.', 2)
  assert.equal(doc.tasks.length, 1, 'no second task')
  assert.match(doc.tasks[0].text, /production release/i)
  const renamed = doc.tasks[0].text
  say(doc, 'user', 'Deploy the final build.', 3)
  assert.equal(doc.tasks[0].text, renamed, 'a later sync does not revert a renamed task')
})

test('cancellation dismisses and reopening restores', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Migrate the database to Postgres.', 1)
  say(doc, 'user', 'Cancel the database migration.', 2)
  assert.equal(project(doc).counts.total, 0)
  assert.equal(doc.tasks[0].status, 'dismissed')
  say(doc, 'user', 'Reopen the database migration.', 3)
  assert.equal(doc.tasks[0].status, 'todo')
  assert.deepEqual(tree(doc), ['Migrate the database to Postgres [todo]'])
})

test('manual edits survive later syncs', () => {
  const doc = scenario()
  const install = doc.tasks.find((t) => t.text === 'Install DSH on my iPad')
  applyManual(doc, { kind: 'rename', id: install.id, text: 'Get DSH onto the iPad' })
  applyManual(doc, { kind: 'complete', id: install.id })

  say(doc, 'user', 'Install DSH on my iPad.', 5)
  say(doc, 'assistant', 'The app needs a provisioning profile.', 6)
  say(doc, 'user', 'Also back up my DSH settings.', 7)

  const after = doc.tasks.find((t) => t.id === install.id)
  assert.equal(after.text, 'Get DSH onto the iPad', 'renamed text kept')
  assert.equal(after.status, 'done', 'manual completion kept')
  assert.equal(new Set(doc.tasks.map((t) => t.id)).size, doc.tasks.length, 'still no duplicates')
})

test('hedged proposals become suggestions, not tasks', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  say(doc, 'assistant', 'The app needs signing.', 2)
  say(doc, 'assistant', 'You may want to consider a second test device.', 3)
  assert.equal(doc.suggestions.length, 1)
  assert.match(doc.suggestions[0].text, /second test device/i)
  assert.equal(doc.tasks.filter((t) => /test device/i.test(t.text)).length, 0)
  applyManual(doc, { kind: 'accept-suggestion', id: doc.suggestions[0].id })
  assert.equal(doc.suggestions.length, 0)
  assert.ok(doc.tasks.some((t) => /second test device/i.test(t.text)))
})

test('brainstorming is ignored', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  say(doc, 'assistant', 'Some ideas: we could brainstorm pricing options.', 2)
  say(doc, 'user', 'What if we also shipped a watch app?', 3)
  assert.deepEqual(tree(doc), ['Install DSH on my iPad [todo]'])
})

test("DSH's native plan is captured as supplemental input, not merged", () => {
  const doc = createDoc('s')
  const captured = ingestNativePlan(doc, {
    type: 'tool/call',
    seq: 9,
    data: {
      type: 'tool/call',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'Write the migration', status: 'in_progress' }] }),
    },
  })
  assert.equal(captured, true)
  assert.equal(project(doc).tasks.length, 0, 'not merged automatically')
  assert.equal(doc.nativePlan.todos.length, 1)
  applyManual(doc, { kind: 'merge-native', id: doc.nativePlan.todos[0].id })
  assert.equal(project(doc).tasks.length, 1)
  assert.equal(project(doc).tasks[0].origin, 'native-plan')
})

test('dismissing a parent dismisses its subtree', () => {
  const doc = scenario()
  const install = doc.tasks.find((t) => t.text === 'Install DSH on my iPad')
  applyManual(doc, { kind: 'dismiss', id: install.id })
  assert.deepEqual(tree(doc), ['Back up my DSH settings [todo]'])
})

test('harness-injected context is not mined as tasks', () => {
  // Regression: the workspace instructions DSH injects into a user turn were
  // being read as dozens of requests, with markdown headings becoming tasks.
  const injected = [
    'Install DSH on my iPad.',
    '<system-reminder>',
    'Instructions from: ~/.dsh/AGENTS.md',
    '## Autonomy',
    '- Approval prompts are disabled here. Do not ask for a go-ahead.',
    '## Before starting',
    'Choose the smallest complete solution. Reuse reviewed primitives.',
    'Never idle-poll — do the next independent piece of work.',
    '</system-reminder>',
  ].join('\n')
  const doc = createDoc('s')
  say(doc, 'user', injected, 1)
  assert.deepEqual(tree(doc), ['Install DSH on my iPad [todo]'])
})

test('statement prose is not a task even without a wrapper tag', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  say(doc, 'user', 'Approval prompts are disabled here.', 2)
  say(doc, 'user', 'The following workspace instructions may be relevant to your work.', 3)
  say(doc, 'assistant', 'This paragraph is explanation, not a request, and it is long enough to read as documentation rather than as work to be tracked.', 4)
  assert.deepEqual(tree(doc), ['Install DSH on my iPad [todo]'])
})

test('an imperative step of the same outcome still nests', () => {
  const doc = createDoc('s')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  say(doc, 'user', 'Then register the iPad.', 2)
  assert.deepEqual(tree(doc), ['Install DSH on my iPad [todo]', '  Register the iPad [todo]'])
})

test('a successful execution linked to a task completes it with provenance', () => {
  const doc = createDoc('s-exec')
  say(doc, 'user', 'Fix the broken .venv so tests can run.', 1)
  const task = doc.tasks[0]
  const ok = ingestToolResult(doc, {
    ok: true,
    toolName: 'bash',
    argumentsText: 'source .venv/bin/activate && pytest -q',
    resultText: '12 passed in 3.1s',
    seq: 7,
  })
  assert.equal(ok, true)
  assert.equal(task.status, 'done')
  assert.equal(task.completedBy.kind, 'execution')
  assert.equal(task.completedBy.sessionId, 's-exec')
  assert.equal(task.completedBy.seq, 7)
  assert.match(task.completedBy.reason, /bash/)
  assert.equal(project(doc).tasks[0].completedBy.kind, 'execution')
})

test('a failed execution leaves the task open', () => {
  const doc = createDoc('s-fail')
  say(doc, 'user', 'Fix the broken .venv so tests can run.', 1)
  ingestToolResult(doc, { ok: false, toolName: 'bash', argumentsText: 'pytest .venv', resultText: 'exit code 1', seq: 5 })
  assert.equal(doc.tasks[0].status, 'todo')
  assert.equal(doc.tasks[0].completedBy, undefined)
})

test('completing a subtask leaves the parent open', () => {
  const doc = createDoc('s-sub')
  say(doc, 'user', 'Install DSH on my iPad.', 1)
  say(doc, 'assistant', 'The app needs signing before it can be installed.', 2)
  const parent = doc.tasks[0]
  const child = doc.tasks.find((t) => t.parentId === parent.id)
  assert.ok(child)
  ingestToolResult(doc, { ok: true, toolName: 'bash', argumentsText: 'codesign --sign signing', resultText: 'signed', seq: 3 })
  assert.equal(child.status, 'done', 'the subtask completes itself')
  assert.equal(parent.status, 'todo', 'the parent outcome is not established by one step')
})

test('assistant prose alone never completes a task', () => {
  const doc = createDoc('s-prose')
  say(doc, 'user', 'Deploy the staging build.', 1)
  say(doc, 'assistant', 'Deploy the staging build is done.', 2)
  assert.equal(doc.tasks[0].status, 'todo')
})

test('a manual override survives automated completion', () => {
  const doc = createDoc('s-manual')
  say(doc, 'user', 'Fix the broken .venv so tests can run.', 1)
  const task = doc.tasks[0]
  applyManual(doc, { kind: 'reopen', id: task.id })
  ingestToolResult(doc, { ok: true, toolName: 'bash', argumentsText: 'pytest .venv', resultText: '1 passed', seq: 4 })
  assert.equal(task.status, 'todo', 'the user set this status by hand')
})

test('reopening a completed task returns it to todo without provenance', () => {
  const doc = createDoc('s-reopen')
  say(doc, 'user', 'Fix the broken .venv so tests can run.', 1)
  const task = doc.tasks[0]
  ingestToolResult(doc, { ok: true, toolName: 'bash', argumentsText: 'pytest .venv', resultText: '1 passed', seq: 2 })
  assert.equal(task.status, 'done')
  applyManual(doc, { kind: 'reopen', id: task.id })
  assert.equal(task.status, 'todo')
  assert.equal(project(doc).tasks[0].status, 'todo')
})

test('screenshot commentary and fragments never become tasks', () => {
  const doc=createDoc('screenshots')
  for(const [seq,text] of [
    'Run in a homelab', 'Before answering — deployment shape matters a lot here',
    'Code → tests → packet → Codex → owner go → gates → rerun',
    'Still need Codex for reviews', "You're certain you can complete this efficiently", 'Until then',
  ].entries()) say(doc,'user',text,seq)
  assert.deepEqual(doc.tasks,[])
})

test('analysis deliverables retain complete descriptions', () => {
  const doc=createDoc('analysis')
  const text='Analyze what you see and tell me the errors or inefficiencies, covering correctness, execution order, resource use, failure handling, and recovery procedures.'
  say(doc,'user',text,1)
  assert.equal(doc.tasks.length,1)
  assert.equal(doc.tasks[0].description,text.slice(0,-1))
  assert.ok(doc.tasks[0].text.length<=100)
  assert.ok(!doc.tasks[0].text.endsWith('and'))
})

test('a polite concrete request is accepted and a capability question is ignored',()=>{
 const doc=createDoc('polite')
 say(doc,'user','Could you install DSH on my iPad?',1)
 say(doc,'user','Are you certain you can install DSH efficiently?',2)
 assert.equal(doc.tasks.length,1)
})

test('read-only tool success cannot complete a deployment task',()=>{
 const doc=createDoc('read')
 say(doc,'user','Deploy the staging build.',1)
 assert.equal(ingestToolResult(doc,{ok:true,toolName:'read',argumentsText:'staging build',resultText:'Deployment successful',seq:3}),false)
 assert.equal(doc.tasks[0].status,'todo')
})

test('failed, unfinished and ambiguous test commands leave work open',()=>{
 const doc=createDoc('partial')
 say(doc,'user','Run the regression tests.',1)
 for(const resultText of ['12 passed, 1 failed','12 passed. Process still running','12 passed. Exit code 1']){
  assert.equal(ingestToolResult(doc,{ok:true,toolName:'bash',argumentsText:'pytest tests/regression',resultText,seq:2}),false)
 }
 assert.equal(doc.tasks[0].status,'todo')
})

test('a test attempt and a fabricated echo do not establish completion',()=>{
 const doc=createDoc('echo')
 say(doc,'user','Run the regression tests.',1)
 for(const command of ['cat tests/regression.log','echo "pytest tests/regression 12 passed"']){
  assert.equal(ingestToolResult(doc,{ok:true,toolName:'bash',argumentsText:JSON.stringify({command}),resultText:'12 passed',seq:2}),false)
 }
})

test('native plan completion matches the exact outcome and preserves manual overrides',()=>{
 const doc=createDoc('native')
 say(doc,'user','Deploy the staging build.',1)
 const task=doc.tasks[0]
 const input={ok:true,toolName:'todo_write',argumentsText:JSON.stringify({todos:[{content:task.autoText,status:'completed'}]}),resultText:'Updated todo list',seq:3}
 assert.equal(ingestToolResult(doc,input),true)
 assert.equal(task.completedBy.kind,'native-plan')
 applyManual(doc,{kind:'reopen',id:task.id})
 assert.equal(ingestToolResult(doc,{...input,seq:4}),false)
 assert.equal(task.completedBy,undefined)
})

test('failed PTC execution and code that only reads results leave tasks open',()=>{
 const doc=createDoc('ptc-failed');say(doc,'user','Run the regression tests.',0)
 const call=command=>JSON.stringify({code:'const r = await tools.bash({command: '+JSON.stringify(command)+'}); console.log(r.stdout.text, r.stderr.text, r.exitCode);'})
 assert.equal(ingestToolResult(doc,{ok:true,toolName:'run_code',argumentsText:call('pytest tests/regression'),resultText:'12 passed\n 1',seq:3}),false)
 assert.equal(ingestToolResult(doc,{ok:true,toolName:'run_code',argumentsText:call('cat tests/regression.log'),resultText:'12 passed\n 0',seq:4}),false)
 assert.equal(doc.tasks[0].status,'todo')
})

test('completed analysis answers close that turn’s deliverable without closing another turn',async()=>{
 const {ingestAnswer}=await import('../lib/engine.js')
 const doc=createDoc('answers')
 say(doc,'user','Analyze the storage errors and inefficiencies.',0)
 say(doc,'user','Explain the memory capacity requirements.',1)
 ingestAnswer(doc,{userSeq:0,assistantSeq:3,text:'The storage errors and inefficiencies come from duplicate caches and expired backup copies. The storage analysis shows which files can be safely removed and which directories must be retained.'})
 assert.equal(doc.tasks[0].status,'done')
 assert.equal(doc.tasks[1].status,'todo')
})

test('an explanation cannot finish a compound execution task or a conditional report',async()=>{
 const {ingestAnswer}=await import('../lib/engine.js')
 const doc=createDoc('compound')
 say(doc,'user','Analyze the storage errors, then delete the unused files.',0)
 say(doc,'user','Report the final status once the run completes.',1)
 const text='The storage errors are explained by unused files. The final status of the run requires further verification. This analysis identifies the storage problems and the file deletion that would address them.'
 ingestAnswer(doc,{userSeq:0,assistantSeq:3,text})
 ingestAnswer(doc,{userSeq:1,assistantSeq:4,text})
 assert.ok(doc.tasks.every(task=>task.status==='todo'))
})

const ptc = (command, exitLine = '0', out = 'done') => ({
  ok: true,
  toolName: 'run_code',
  argumentsText: JSON.stringify({
    code: `const r = await tools.bash({ command: ${JSON.stringify(command)} }); console.log(r.stdout.text, r.stderr.text, r.exitCode);`,
  }),
  resultText: `${out}\n${exitLine}`,
  seq: 900,
})

test('run_code bash exiting 0 completes a matching execution task', () => {
  const doc = createDoc('s-ptc')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  const task = doc.tasks[0]
  assert.equal(ingestToolResult(doc, ptc('docker compose -f phase0.yml up -d')), true)
  assert.equal(task.status, 'done')
  assert.equal(task.completedBy.kind, 'execution')
  assert.match(task.completedBy.reason, /exited 0/)
})

test('run_code exiting non-zero leaves the task open', () => {
  const doc = createDoc('s-ptc2')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  assert.equal(ingestToolResult(doc, ptc('docker compose -f phase0.yml up -d', '1')), false)
  assert.equal(doc.tasks[0].status, 'todo')
})

test('a read-only run_code command never completes a task', () => {
  const doc = createDoc('s-ptc3')
  say(doc, 'user', 'Check the phase0 compose stack.', 1)
  assert.equal(ingestToolResult(doc, ptc('git status')), false)
  assert.equal(doc.tasks[0].status, 'todo')
})

test('an ambiguous success completes nothing', () => {
  const doc = createDoc('s-ptc4')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  say(doc, 'user', 'Start the phase0 compose worker.', 2)
  assert.equal(ingestToolResult(doc, ptc('docker compose -f phase0.yml up -d')), false)
  assert.deepEqual(doc.tasks.map((t) => t.status), ['todo', 'todo'])
})

const bashCall = (command, tail) => ({
  ok: true,
  toolName: 'bash',
  argumentsText: JSON.stringify({ command }),
  resultText: `some output\n${tail}`,
  seq: 901,
})

test('a plain bash call reporting [exit: 0] completes a matching execution task', () => {
  const doc = createDoc('s-bash')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  assert.equal(ingestToolResult(doc, bashCall('docker compose -f phase0.yml up -d', '[exit: 0 ]')), true)
  assert.equal(doc.tasks[0].status, 'done')
  assert.match(doc.tasks[0].completedBy.reason, /exited 0/)
})

test('a plain bash call with a non-zero exit leaves the task open', () => {
  const doc = createDoc('s-bash2')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  assert.equal(ingestToolResult(doc, bashCall('docker compose -f phase0.yml up -d', '[exit code: 1]')), false)
  assert.equal(doc.tasks[0].status, 'todo')
})

test('a plain read-only bash call never completes a task', () => {
  const doc = createDoc('s-bash3')
  say(doc, 'user', 'Check the phase0 compose stack.', 1)
  assert.equal(ingestToolResult(doc, bashCall('git status', '[exit: 0 ]')), false)
  assert.equal(doc.tasks[0].status, 'todo')
})

test('successfulCommand recognises only real zero-exit shell calls', () => {
  assert.equal(successfulCommand({ ok: true, toolName: 'bash', argumentsText: '{"command":"docker compose up -d"}', resultText: 'up\n[exit: 0 ]' }), 'docker compose up -d')
  assert.equal(successfulCommand({ ok: true, toolName: 'bash', argumentsText: '{"command":"docker compose up -d"}', resultText: 'boom\n[exit code: 1]' }), null)
  assert.equal(successfulCommand({ ok: true, toolName: 'bash', argumentsText: '{"command":"git status"}', resultText: '[exit: 0 ]' }), null)
  assert.equal(successfulCommand({ ok: false, toolName: 'bash', argumentsText: '{"command":"x"}', resultText: '[exit: 0 ]' }), null)
  const wrapped = successfulCommand({
    ok: true, toolName: 'run_code',
    argumentsText: JSON.stringify({ code: `const r = await tools.bash({ command: "docker compose up -d" }); console.log(r.stdout.text, r.stderr.text, r.exitCode);` }),
    resultText: 'up\n0',
  })
  assert.equal(wrapped, 'docker compose up -d')
})

test('completeByMapping closes one open task and refuses locks', () => {
  const doc = createDoc('s-map')
  say(doc, 'user', 'Start the phase0 compose stack.', 1)
  const task = doc.tasks[0]
  assert.equal(completeByMapping(doc, { taskId: task.id, seq: 77, command: 'docker compose up -d' }), true)
  assert.equal(task.status, 'done')
  assert.match(task.completedBy.reason, /model mapped an exit-0 command/)
  assert.equal(completeByMapping(doc, { taskId: task.id, seq: 78, command: 'x' }), false, 'already done')

  const doc2 = createDoc('s-map2')
  say(doc2, 'user', 'Start the phase0 compose stack.', 1)
  applyManualStatusLock(doc2, doc2.tasks[0].id)
  assert.equal(completeByMapping(doc2, { taskId: doc2.tasks[0].id, seq: 79, command: 'y' }), false, 'manual lock wins')
})
