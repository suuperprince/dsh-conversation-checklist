/**
 * Engine behaviour. Expectations come from the acceptance scenario, not from
 * the implementation: the scenario is stated in prose, the assertions below
 * restate its observable requirements.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDoc, ingestMessage, applyManual, ingestNativePlan, project } from '../lib/engine.js'

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
