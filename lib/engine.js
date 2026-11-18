/**
 * Deterministic checklist engine.
 *
 * Pure: every export is a function over plain JSON documents, so the same input
 * always folds to the same document, and replaying an event cannot create a
 * second copy of a task (task ids are content-derived hashes).
 *
 * The engine never talks to DSH, the network, or the disk. The Host half feeds
 * it session events and persists the result.
 */

import { createHash } from 'node:crypto'

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'dismissed']

/** Bump when extraction rules change: stored documents re-derive from history. */
export const EXTRACTOR_VERSION = 9

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'on', 'in', 'for', 'and', 'or', 'but', 'with', 'my', 'me', 'i',
  'you', 'your', 'we', 'our', 'it', 'its', 'is', 'are', 'am', 'be', 'been', 'was', 'were', 'do',
  'does', 'did', 'will', 'would', 'can', 'could', 'should', 'need', 'needs', 'want', 'wants',
  'also', 'just', 'so', 'that', 'this', 'then', 'next', 'now', 'please', 'let', 'lets', 'us',
  'have', 'has', 'had', 'get', 'got', 'up', 'out', 'about', 'if', 'when', 'as', 'at', 'by',
  'from', 'into', 'than', 'there', 'here', 'what', 'which', 'who', 'how', 'why', 'ok', 'okay',
])

/** Marker prefixes that make a sentence a step of an existing outcome. */
const HEDGES = /\b(maybe|perhaps|possibly|might|could consider|you may want to|you might want to|optionally|if you (?:want|like|prefer)|consider)\b/i
const BRAINSTORM = /\b(brainstorm|idea|ideas|what if|how about|thoughts on|think about|explore|some options|maybe we should think)\b/i
const QUESTION = /^(?:what|why|how|when|where|who|which|can|could|should|would|do|does|did|is|are|will)\b/i

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function stem(word) {
  let w = word.toLowerCase()
  if (w.length <= 3) return w
  for (const suffix of ['ation', 'itions', 'ition', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'ed', 'es', 'ly']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length)
  }
  if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) return w.slice(0, -1)
  return w
}

export function tokens(text) {
  const out = []
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (raw.length < 2) continue
    if (STOPWORDS.has(raw)) continue
    out.push(stem(raw))
  }
  return [...new Set(out)]
}

/** Tokens that appear in every existing task carry no discriminating power. */
function ubiquitous(docs) {
  if (docs.length < 2) return new Set()
  const seen = new Map()
  for (const t of docs) for (const tok of new Set(tokens(t))) seen.set(tok, (seen.get(tok) ?? 0) + 1)
  const out = new Set()
  for (const [tok, n] of seen) if (n >= Math.max(3, docs.length)) out.add(tok)
  return out
}

function score(probe, candidate, skip) {
  const a = probe.filter((t) => !skip.has(t))
  const b = candidate.filter((t) => !skip.has(t))
  if (a.length === 0 || b.length === 0) return 0
  const B = new Set(b)
  const shared = a.filter((t) => B.has(t)).length
  if (shared === 0) return 0
  const jaccard = shared / (a.length + b.length - shared)
  const containment = shared / Math.min(a.length, b.length)
  return Math.max(jaccard, containment)
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const key = (text, parentId) => `${String(text).trim().toLowerCase().replace(/\s+/g, ' ')}|${parentId ?? ''}`
export const taskId = (text, parentId = null) => `t-${createHash('sha1').update(key(text, parentId)).digest('hex').slice(0, 10)}`
export const suggestionId = (text, seq) => `s-${createHash('sha1').update(`${key(text)}@${seq}`).digest('hex').slice(0, 10)}`

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function createDoc(sessionId) {
  return {
    version: 2,
    extractorVersion: EXTRACTOR_VERSION,
    sessionId: String(sessionId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    processedSeq: -1,
    sequence: 0,
    tasks: [],
    suggestions: [],
    nativePlan: null,
  }
}

export function clone(doc) {
  return JSON.parse(JSON.stringify(doc))
}

const nextSequence = (doc) => ++doc.sequence

export function findTask(doc, id) {
  return doc.tasks.find((t) => t.id === id)
}

function activeTasks(doc) {
  return doc.tasks.filter((t) => t.status !== 'dismissed')
}

function focusTask(doc) {
  // Most recently touched top-level task that is neither done nor dismissed.
  const roots = doc.tasks.filter((t) => t.parentId === null && !['done', 'dismissed'].includes(t.status))
  if (roots.length === 0) return null
  return roots.reduce((best, t) => (t.sequence > best.sequence ? t : best), roots[0])
}

function scoreDetail(probe, candidate, skip) {
  const a = probe.filter((t) => !skip.has(t))
  const b = candidate.filter((t) => !skip.has(t))
  if (a.length === 0 || b.length === 0) return { score: 0, jaccard: 0 }
  const B = new Set(b)
  const shared = a.filter((t) => B.has(t)).length
  if (shared === 0) return { score: 0, jaccard: 0 }
  const jaccard = shared / (a.length + b.length - shared)
  return { score: Math.max(jaccard, shared / Math.min(a.length, b.length)), jaccard }
}

function matchTask(doc, probeText, { includeDismissed = false } = {}) {
  const probe = tokens(probeText)
  if (probe.length === 0) return null
  const pool = includeDismissed ? doc.tasks : activeTasks(doc)
  const skip = ubiquitous(doc.tasks.map((t) => t.text))
  let best = null
  let bestScore = 0
  let bestJaccard = 0
  for (const task of pool) {
    const detail = scoreDetail(probe, tokens(task.text), skip)
    const better =
      detail.score > bestScore ||
      // On a containment tie prefer the tighter match, then the established task.
      (detail.score === bestScore && detail.score > 0 && detail.jaccard > bestJaccard) ||
      (detail.score === bestScore && detail.jaccard === bestJaccard && best !== null && task.sequence < best.sequence)
    if (better) {
      best = task
      bestScore = detail.score
      bestJaccard = detail.jaccard
    }
  }
  return bestScore >= 0.5 ? best : null
}

function childrenOf(doc, parentId) {
  return doc.tasks.filter((t) => t.parentId === parentId)
}

function rollUpStatus(doc) {
  for (const parent of [...doc.tasks].reverse()) {
    if (parent.status === 'dismissed' || parent.status === 'done' || parent.manual?.status) continue
    const kids = childrenOf(doc, parent.id).filter((t) => t.status !== 'dismissed')
    const blocked = kids.find((t) => t.status === 'blocked')
    if (parent.status !== 'blocked' && blocked) {
      setStatus(doc, parent, 'blocked', { blockedBy: blocked.blockedBy ?? blocked.text })
      parent.blockedByChildId = blocked.id
    } else if (parent.status === 'blocked') {
      const dependency = kids.find((t) => t.id === parent.blockedByChildId || t.autoText === parent.blockedBy)
      if (dependency?.status === 'done' || (parent.blockedByChildId && !dependency)) {
        setStatus(doc, parent, 'todo')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations (all preserve manual edits)
// ---------------------------------------------------------------------------

function addTask(doc, { text, parentId = null, status = 'todo', sourceSeq, sourceRef, origin = 'conversation', blockedBy = null, automated = true }) {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length === 0) return null
  // Single choke point: every automated addition passes the same bar, whoever
  // proposed it (rules, needs-paragraph, blocker clause, native plan, model).
  if (automated && !isAcceptableTask(clean)) return null
  const id = taskId(clean, parentId)
  const existing = findTask(doc, id)
  if (existing) return existing
  // Replay and paraphrase protection: the same outcome stated twice keeps one row.
  const probe = tokens(clean)
  const skip = ubiquitous(doc.tasks.map((t) => t.text))
  for (const sibling of doc.tasks) {
    if (sibling.parentId !== parentId) continue
    if (sibling.status === 'dismissed') continue
    if (score(probe, tokens(sibling.autoText ?? sibling.text), skip) >= 0.7) return sibling
  }
  const task = {
    id,
    parentId,
    text: taskTitle(clean),
    description: clean,
    // The text this row was derived from. A manual rename changes `text` only,
    // so re-reading the message that created it still finds this row.
    autoText: clean,
    status,
    blockedBy: blockedBy ?? null,
    sourceSeq: sourceSeq ?? null,
    sourceRef: sourceRef ?? null,
    origin,
    manual: {},
    sequence: nextSequence(doc),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  doc.tasks.push(task)
  return task
}

function setStatus(doc, task, status, { blockedBy = null, force = false } = {}) {
  if (!task) return false
  if (task.manual?.status && !force) return false
  if (task.status === status && (task.blockedBy ?? null) === (blockedBy ?? null)) return false
  task.status = status
  delete task.blockedByChildId
  if (status !== 'done') delete task.completedBy
  task.blockedBy = status === 'blocked' ? (blockedBy ?? task.blockedBy ?? 'an unstated dependency') : null
  task.updatedAt = Date.now()
  task.sequence = nextSequence(doc)
  return true
}

/**
 * Record a completion and why it happened. Manual overrides win: an automated
 * caller can never overwrite a status the user set by hand.
 */
function completeTask(doc, task, evidence) {
  if (!task || task.manual?.status || task.status === 'dismissed' || task.status === 'done') return false
  if (!setStatus(doc, task, 'done')) return false
  task.completedBy = { kind: evidence.kind, sessionId: doc.sessionId, seq: evidence.seq ?? null,
    reason: String(evidence.reason ?? '').slice(0, 180), at: Date.now() }
  rollUpStatus(doc)
  return true
}

/** Match the action and object, using the call inputs before reading the output. */
function linkTaskToEvidence(doc, command, type) {
  const action = {
    tests: /\b(?:tests?|regressions?|pytest|venv|verification)\b/i,
    signing: /\b(?:sign|signing|codesign)\b/i,
    write: /\b(?:write|create|draft|document|save)\b/i,
    command: /\b(?:run|execute|apply|build|deploy|install|start|stop|restart|rebuild|migrate|commit|push|upgrade|configure|fix|check|verify|release)\b/i,
  }[type]
  if (!action) return null
  const probe = new Set(tokens(command + (type === 'tests' ? ' tests' : '')))
  const matches = doc.tasks.filter(task => {
    if (!['todo', 'doing'].includes(task.status) || task.manual?.status || !action.test(task.autoText ?? task.text)) return false
    const own = tokens(task.autoText ?? task.text)
    const shared = own.filter(token => probe.has(token)).length
    return type === 'signing' ? true : shared >= 2 && shared / own.length >= 0.4
  })
  // An ambiguous success cannot establish which outcome finished.
  return matches.length === 1 ? matches[0] : null
}

/** Decode a single literal PTC shell call without evaluating conversation code. */
function unwrapPtc(input) {
  let outer
  try { outer = JSON.parse(input.argumentsText) } catch { return null }
  if (typeof outer.code !== 'string') return null
  const code = outer.code
  const wrapper = code.match(/^\s*(?:const|let)\s+([\w$]+)\s*=\s*await\s+tools\.bash\(\s*(\{[\s\S]*\})\s*\);?\s*console\.log\(\s*\1\.stdout\.text\s*,\s*\1\.stderr\.text\s*,\s*\1\.exitCode\s*\);?\s*$/)
  if (!wrapper || (code.match(/\btools\./g) ?? []).length !== 1) return null
  const literal = wrapper[2].match(/\bcommand\s*:\s*("(?:\\.|[^"\\])*")/)
  if (!literal) return null
  let command
  try { command = JSON.parse(literal[1]) } catch { return null }
  const exit = input.resultText.match(/(?:^|\n)\s*(-?\d+)\s*$/)
  if (!exit || Number(exit[1]) !== 0) return null
  return { ...input, toolName: 'bash', argumentsText: JSON.stringify({command}), resultText: input.resultText.slice(0, exit.index) }
}

/**
 * The command a verified success proves, or null. One predicate for both the
 * automatic path and the model-mapping path, so they cannot disagree about
 * what counts as a successful execution.
 */
export function successfulCommand(input) {
  if (!input || input.ok !== true) return null
  if (input.toolName === 'run_code') {
    const nested = unwrapPtc(input)
    if (!nested) return null
    let args = {}
    try { args = JSON.parse(nested.argumentsText) } catch { return null }
    const command = String(args.command ?? '')
    if (!command || READ_ONLY_COMMAND.test(command)) return null
    if (/(?:exit(?:ed)?(?: with)?(?: code| status)?[: ]+[1-9]|[1-9]\d* failed|timed? out|interrupted|cancelled|aborted|still running)/i.test(nested.resultText)) return null
    return command
  }
  if (!/^(?:bash|shell|exec_command|terminal_exec)$/.test(input.toolName ?? '')) return null
  if (!/\[\s*exit(?:\s*code)?\s*[: ]\s*0\s*\]/i.test(input.resultText ?? '')) return null
  let args = {}
  try { args = JSON.parse(input.argumentsText) } catch { return null }
  const command = String(args.command ?? args.cmd ?? '')
  if (!command || READ_ONLY_COMMAND.test(command)) return null
  return command
}

/**
 * Close the task a model chose for a verified success. The model only answers
 * "which open task does this finished command establish"; it cannot invent a
 * success, because the caller passes a command that already exited 0.
 */
export function completeByMapping(doc, { taskId, seq, command, sessionId }) {
  const task = doc.tasks.find((item) => item.id === taskId)
  if (!task) return false
  if (!['todo', 'doing'].includes(task.status)) return false
  if (task.manual?.status) return false
  return completeTask(doc, task, {
    kind: 'execution',
    sessionId: sessionId ?? doc.sessionId,
    seq,
    reason: `model mapped an exit-0 command to this task: ${String(command).slice(0, 100)}`,
  })
}

/** Commands whose success says nothing about an outcome (reads, listings). */
const READ_ONLY_COMMAND = /^\s*(?:ls|cat|head|tail|grep|rg|pwd|echo|which|wc|stat|find|git\s+(?:status|log|diff|show)|docker\s+ps|ps|df|du|env|printenv)\b/i

const toolLabelFor = (command) => (command.includes('\n') ? 'bash script' : 'bash')

/** Close one execution-shaped task for a command that exited 0. */
function ingestCommandEvidence(doc, command, resultText, seq) {
  if (/(?:exit(?:ed)?(?: with)?(?: code| status)?[: ]+[1-9]|[1-9]\d* failed|timed? out|interrupted|cancelled|aborted|still running)/i.test(resultText)) return false
  const task = linkTaskToEvidence(doc, command, 'command')
  if (task === null) return false
  return completeTask(doc, task, {
    kind: 'execution',
    sessionId: doc.sessionId,
    seq,
    reason: `${toolLabelFor(command)} exited 0: ${command.slice(0, 110)}`,
  })
}

/**
 * An assistant claim that the work was finished, verified or passed. This is a
 * deliberate loosening for work whose success only exists as prose: it is
 * narrow on purpose — an explicit completion verb, a claim that names the task's
 * object, an open non-manual task that already existed, and no hedge or question.
 */
const CLAIM = /\b(?:done|complete|completed|finished|verified|confirmed|succeeded|passed|passing|works|working|shipped|closed|fixed|resolved|ready)\b/i
const HEDGE_OR_FUTURE = /\b(?:should|would|could|might|may|will|plan to|going to|next|unless|if you|need to|still|not yet|failed|blocked|couldn't|cannot|can't|unable)\b/i
const DESTRUCTIVE = /\b(?:delete|remove|drop|destroy|deploy|release|publish|push|migrate|transfer|pay|spend|purchase|book)\b/i

export function completeFromAssistantProse(doc, { text, seq, sessionId }) {
  let changed = false
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
    const claim = sentence.trim()
    if (claim.length < 8 || claim.length > 140) continue
    if (/[\[\]{}$]|`|^\s*(?:[-*]|\d+[.)])\s/.test(claim)) continue
    if (question(claim) || !CLAIM.test(claim) || HEDGE_OR_FUTURE.test(claim)) continue
    const probe = new Set(tokens(claim))
    if (probe.size < 2) continue
    const matches = doc.tasks.filter((task) => {
      if (!['todo', 'doing', 'blocked'].includes(task.status)) return false
      if (task.manual?.status) return false
      if (typeof task.sourceSeq === 'number' && typeof seq === 'number' && task.sourceSeq >= seq) return false
      const own = tokens(task.autoText ?? task.text)
      if (own.length === 0) return false
      // A compound or destructive outcome is not established by a sentence.
      if (DESTRUCTIVE.test(task.text) && !/\b(?:verified|confirmed|checked)\b/i.test(claim)) return false
      const shared = own.filter((t) => probe.has(t)).length
      return (shared >= 2 && shared / own.length >= 0.6) || (shared >= 1 && shared / own.length >= 0.6 && own.length <= 3)
    })
    if (matches.length !== 1) continue
    changed = completeTask(doc, matches[0], {
      kind: 'assistant-verified',
      sessionId: sessionId ?? doc.sessionId,
      seq,
      reason: `assistant reported completion: ${claim.slice(0, 120)}`,
    }) || changed
  }
  return changed
}

const question = (text) => /\?\s*$/.test(text) || /^(?:did|does|do|is|are|was|were|can|could|should)\b/i.test(text)

export function ingestToolResult(doc, input) {
  if (input.toolName === 'run_code') {
    if (input.ok !== true) return false
    const nested = unwrapPtc(input)
    // The wrapper already proved: one literal tools.bash call, and its logged
    // nested exit code is 0. That is execution evidence, so a matching
    // execution-shaped task can close (a read-only command never does).
    if (!nested) return false
    const args = (() => { try { return JSON.parse(nested.argumentsText) } catch { return {} } })()
    const command = String(args.command ?? '')
    if (command && !READ_ONLY_COMMAND.test(command)) {
      const made = ingestCommandEvidence(doc, command, nested.resultText, nested.seq)
      if (made) return true
    }
    return ingestToolResult(doc, nested)
  }
  const { ok, toolName = '', argumentsText = '', resultText = '', seq = null } = input
  if (ok !== true || /(?:exit(?:ed)?(?: with)?(?: code| status)?[: ]+[1-9]|[1-9]\d* failed|timed? out|interrupted|cancelled|aborted|still running|session ID|process running)/i.test(resultText)) return false
  let args
  try { args = JSON.parse(argumentsText) } catch { args = { command: argumentsText } }
  if (toolName === 'todo_write' && Array.isArray(args.todos)) {
    let changed = false
    for (const entry of args.todos) {
      if (entry?.status !== 'completed' || typeof entry.content !== 'string') continue
      const task = doc.tasks.find(item => (item.autoText ?? item.text).toLowerCase().trim() === entry.content.toLowerCase().trim())
      changed = completeTask(doc, task, { kind: 'native-plan', seq, reason: 'Session plan marked this task completed' }) || changed
    }
    return changed
  }
  const command = String(args.command ?? args.cmd ?? '')
  let type = null
  if (/^(?:bash|shell|exec_command|terminal_exec)$/.test(toolName)) {
    if (/(?:^|[;&\n]\s*)(?:(?:python(?:3)?|uv run)\s+(?:-m\s+)?)?(?:(?:[.\w\/-]+\/)?pytest|npm test|npm run test|pnpm test|node --test)\b/.test(command) && /(?:\b[1-9]\d* passed\b|# pass [1-9]|ℹ pass [1-9]|Tests?:.*[1-9]\d* passed)/i.test(resultText)) type = 'tests'
    if (/(?:^|[;&\n]\s*)codesign\s+(?:--verify|--sign)\b/.test(command) && /signed|valid on disk|satisfies its designated requirement/i.test(resultText)) type = 'signing'
  } else if (/^(?:write|write_file)$/.test(toolName) && /(?:wrote|written|created|saved|success)/i.test(resultText)) {
    type = 'write'
  }
  // A plain shell call that reports an explicit zero exit is execution evidence
  // for an execution-shaped task, exactly like the decoded PTC wrapper. Without
  // this, conversations that drive `bash` directly (139 calls in one session)
  // could never complete anything.
  if (!type && /\[\s*exit(?:\s*code)?\s*[: ]\s*0\s*\]/i.test(resultText)) {
    const commandText = String(args.command ?? args.cmd ?? '')
    if (commandText && !READ_ONLY_COMMAND.test(commandText)) {
      return ingestCommandEvidence(doc, commandText, resultText, seq)
    }
  }
  if (!type) return false
  const task = linkTaskToEvidence(doc, command || String(args.file_path ?? args.path ?? args.filePath ?? ''), type)
  return completeTask(doc, task, {kind:'execution', seq, reason: toolName + ': ' + (type === 'tests' ? 'linked test command finished with passing results' : 'linked operation verified successfully')})
}

/** An answer is itself the deliverable for a request to explain or analyze. */
export function ingestAnswer(doc, { userSeq, assistantSeq, text }) {
  if (typeof text !== 'string' || text.length < 120 || /\b(?:cannot|unable to|need more information|please provide|awaiting your|not yet completed)\b/i.test(text)) return false
  const response = new Set(tokens(text))
  let changed = false
  for (const task of doc.tasks) {
    if (task.sourceSeq !== userSeq || !/^(?:(?:analy[sz]e|explain|summari[sz]e|compare|report|translate)\b|(?:confirm|check|verify)\s+whether\b)/i.test(task.autoText ?? task.text)) continue
    const request = task.autoText ?? task.text
    if (/\b(?:once|when|until|after)\b/i.test(request) || /\b(?:and|then|before)\s+(?:delete|deploy|install|run|execute|commit|push|build|generate|remove|restart|fix|implement)\b/i.test(request)) continue
    const shared = tokens(request).filter(token => response.has(token)).length
    if (shared < 2) continue
    changed = completeTask(doc, task, {kind:'answer-delivered', seq:assistantSeq, reason:'The requested answer was delivered in this completed turn'}) || changed
  }
  return changed
}

function renameTask(doc, task, text) {
  if (!task || task.manual?.renamed) return false
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length === 0 || clean === task.text) return false
  task.text = clean
  task.updatedAt = Date.now()
  task.sequence = nextSequence(doc)
  return true
}

export function applyManual(doc, op) {
  const task = op.id ? findTask(doc, op.id) : null
  switch (op.kind) {
    case 'rename': {
      if (!task || typeof op.text !== 'string') return false
      const text = op.text.trim().replace(/\s+/g, ' ')
      if (!text) return false
      task.text = text
      task.manual = { ...task.manual, renamed: true }
      task.updatedAt = Date.now()
      task.sequence = nextSequence(doc)
      return true
    }
    case 'complete': {
      if (!task) return false
      const changed = !task.manual?.status
      task.manual = { ...task.manual, status: true }
      const updated = setStatus(doc, task, 'done', { force: true })
      rollUpStatus(doc)
      if (updated) task.completedBy = { kind: 'manual', sessionId: doc.sessionId, seq: null, reason: 'Checked complete by user', at: Date.now() }
      return changed || updated
    }
    case 'reopen': {
      if (!task) return false
      if (task.status === 'dismissed') return applyManual(doc, { ...op, kind: 'restore' })
      const changed = !task.manual?.status
      task.manual = { ...task.manual, status: true }
      return setStatus(doc, task, 'todo', { force: true }) || changed
    }
    case 'dismiss':
      if (!task) return false
      setStatus(doc, task, 'dismissed', { force: true })
      task.manual = { ...task.manual, dismissed: true, status: true }
      task.updatedAt = Date.now()
      task.sequence = nextSequence(doc)
      // Descendants retain their own statuses and become visible again on restore.
      rollUpStatus(doc)
      return true
    case 'restore':
      if (!task) return false
      task.status = 'todo'
      delete task.manual?.dismissed
      task.manual = { ...task.manual, status: true }
      task.updatedAt = Date.now()
      task.sequence = nextSequence(doc)
      return true
    case 'accept-suggestion': {
      const suggestion = doc.suggestions.find((s) => s.id === op.id)
      if (!suggestion) return false
      const created = addTask(doc, {
        text: suggestion.text,
        automated: false,
        parentId: suggestion.parentId ?? null,
        sourceSeq: suggestion.sourceSeq,
        sourceRef: suggestion.sourceRef,
        origin: 'conversation',
      })
      if (!created) return false
      created.manual = { ...created.manual, retained: true }
      doc.dismissedSuggestions = [...(doc.dismissedSuggestions ?? []), suggestion.id]
      doc.suggestions = doc.suggestions.filter((s) => s.id !== op.id)
      return true
    }
    case 'dismiss-suggestion': {
      const before = doc.suggestions.length
      doc.suggestions = doc.suggestions.filter((s) => s.id !== op.id)
      if (doc.suggestions.length === before) return false
      doc.dismissedSuggestions = [...(doc.dismissedSuggestions ?? []), op.id]
      return true
    }
    case 'merge-native': {
      // Pull one entry of DSH's native plan into this checklist as a task.
      const entry = doc.nativePlan?.todos?.find((t) => t.id === op.id)
      if (!entry) return false
      addTask(doc, {
        automated: false,
        text: entry.content,
        sourceSeq: entry.sourceSeq ?? null,
        sourceRef: entry.sourceRef ?? null,
        origin: 'native-plan',
        status: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'doing' : 'todo',
      })
      return true
    }
    default:
      return false
  }
}

/**
 * Apply a structured operation list — the shape the optional model extractor
 * returns. Kept here so both extraction paths write through one code path.
 */
export function applyOps(doc, ops, seq = null) {
  let changed = false
  const sourceRef = seq === null ? null : `seq:${seq}`
  for (const op of Array.isArray(ops) ? ops : []) {
    switch (op?.op) {
      case 'add': {
        if (typeof op.text !== 'string') break
        const parent = typeof op.parent === 'string' ? findTask(doc, op.parent) : null
        if (op.parent && (!parent || parent.status === 'dismissed')) break
        const count = doc.tasks.length
        addTask(doc, { text: op.text.slice(0, 2000), parentId: parent?.id ?? null, sourceSeq: seq, sourceRef })
        changed = doc.tasks.length !== count || changed
        break
      }
      case 'suggest':
        if (typeof op.text === 'string') {
          const count = doc.suggestions.length
          addSuggestion(doc, op.text, seq, sourceRef, 'model')
          changed = doc.suggestions.length !== count || changed
        }
        break
      case 'cancel':
      case 'reopen':
        changed = setStatus(doc, findTask(doc, op.id), { complete: 'done', cancel: 'dismissed', reopen: 'todo' }[op.op]) || changed
        break
      case 'rename':
        changed = renameTask(doc, findTask(doc, op.id), String(op.text ?? '')) || changed
        break
      case 'block': {
        const task = findTask(doc, op.id)
        if (!task || task.manual?.status) break
        const blocker = typeof op.waitingFor === 'string' ? op.waitingFor.trim().slice(0, 220) : ''
        changed = setStatus(doc, task, 'blocked', { blockedBy: blocker || null }) || changed
        if (blocker) {
          const count = doc.tasks.length
          addTask(doc, { text: blocker, parentId: task.id, sourceSeq: seq, sourceRef })
          changed = doc.tasks.length !== count || changed
        }
        break
      }
      default:
        break
    }
  }
  rollUpStatus(doc)
  return changed
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Harness-injected context (reminders, skill catalogs) is not a user request. */
const INJECTED = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<available_skills>[\s\S]*?<\/available_skills>/gi,
  /<hindsight_pages>[\s\S]*?<\/hindsight_pages>/gi,
  /<hindsight_page_refresh>[\s\S]*?<\/hindsight_page_refresh>/gi,
  /^[\s\S]*?Instructions from?:[\s\S]*$/i,
]

export function stripInjected(text) {
  let out = String(text ?? '')
  for (const pattern of INJECTED) out = out.replace(pattern, ' ')
  return out
}

const EXAMPLE_SECTION = /^(?:use (?:this|the following) (?:acceptance |test )?(?:scenario|example)|verify in the actual .*ui|acceptance (?:criteria|tests?|scenario)|test (?:cases?|scenarios?)|examples?)\s*:?$/i

const DOC_LINE = /^(?:#{1,6}\s|\||\*\*|---|>\s|```)/

function splitClauses(text) {
  return stripInjected(text)
    .replace(/^[ 	]*```[^\n]*\n[\s\S]*?(?:^[ 	]*```[^\n]*$|$(?![\s\S]))/gm, '')
    .split(/\r?\n[ 	]*\r?\n/)
    .filter((paragraph) => !EXAMPLE_SECTION.test(paragraph.trim().split(/\r?\n/, 1)[0].replace(/^#+\s*/, '')))
    .flatMap((paragraph) => paragraph.replace(/\r?\n(?![ 	]*(?:[-*•]\s|\d+[.)]\s|#|>|\|))/g, ' ').split(/\r?\n/))
    .filter((line) => !DOC_LINE.test(line.trim()) && !/^\s*\d+[.)]\s+(?:I |The conversation )/i.test(line))
    .flatMap((line) => line.split(/(?<=[.!?;])\s+|,\s+but\s+|\s+but\s+|\s+;\s+/))
    .map((c) => c.replace(/^[\s\-*•>]+/, '').replace(/[.!?;]+$/, '').trim())
    .filter((c) => c.length >= 4 && c.length <= 2000)
}

const COMPLETION = [
  /^(?:i\s+)?(?:have\s+)?(?:just\s+)?(?:finished|completed|done with|signed off on)\s+(.+)$/i,
  /^(.+?)\s+(?:is|are)\s+(?:now\s+)?(?:done|complete|completed|finished)$/i,
  /^(.+?)\s+(?:is|are)\s+(?:now\s+)?signed$/i,
  /^(?:i\s+)?(?:did|finished|completed|signed)\s+(.+)$/i,
  /^done\s*[—:-]\s*(.+)$/i,
  /^(.+?)\s+(?:works|worked|passed|succeeded)$/i,
]
const BLOCKED = [
  /^(.+?)\s+(?:is|are)\s+blocked\s+(?:until|on|by|pending|waiting (?:on|for))\s+(.+)$/i,
  /^(.+?)\s+(?:is|are)\s+waiting (?:on|for)\s+(.+)$/i,
  /^(?:we\s+)?can(?:no|')t\s+(.+?)\s+until\s+(.+)$/i,
  /^(.+?)\s+is\s+stuck\s+(?:on|until|because of)\s+(.+)$/i,
]
const CANCEL = [
  /^(?:please\s+)?(?:cancel|drop|forget|skip|abandon)\s+(.+)$/i,
  /^(?:never\s*mind|nvm)\s*(?:about)?\s*(.+)$/i,
  /^(?:i'?m\s+)?not\s+(?:doing|going to do)\s+(.+)$/i,
  /^(?:don'?t|do not)\s+(?:do|bother with)\s+(.+)$/i,
]
const REOPEN = [
  /^re-?open\s+(.+)$/i,
  /^(.+?)\s+is\s+not\s+(?:done|finished|complete)$/i,
  /^(.+?)\s+(?:still\s+)?(?:needs?|requires?)\s+(?:to be )?(?:done|work|attention)$/i,
  /^(.+?)\s+(?:isn'?t|aren'?t|is not|are not)\s+(?:done|finished|complete)$/i,
]
const RENAME = [
  /^(?:actually,?\s*)?(?:please\s+)?re-?name\s+(.+?)\s+to\s+(.+)$/i,
  /^(?:actually,?\s*)?(?:please\s+)?change\s+(.+?)\s+to\s+(.+)$/i,
  /^(?:no,?\s*)?i\s+meant\s+(.+)$/i,
  /^(?:instead,?\s*)(?:make it|call it|use)\s+(.+)$/i,
  /^(?:actually,?\s*)(?:it'?s|it is)\s+(.+)$/i,
]
/** Verbs that open an imperative request. A bare sentence needs one of these. */
const IMPERATIVES = new Set([
  'install', 'back', 'write', 'deploy', 'build', 'create', 'add', 'fix', 'migrate', 'register',
  'sign', 'review', 'run', 'test', 'update', 'remove', 'delete', 'configure', 'set', 'ship',
  'merge', 'prepare', 'check', 'verify', 'move', 'rename', 'refactor', 'upgrade', 'downgrade',
  'commit', 'push', 'pull', 'clone', 'open', 'close', 'restart', 'stop', 'start', 'enable',
  'disable', 'clean', 'document', 'draft', 'send', 'email', 'schedule', 'plan', 'restore',
  'backup', 'publish', 'release', 'revert', 'rotate', 'measure', 'benchmark', 'profile',
  'audit', 'validate', 'confirm', 'grant', 'revoke', 'wire', 'sketch', 'translate', 'summarize',
  'analyze', 'analyse', 'explain', 'investigate', 'trace', 'compare', 'reproduce', 'diagnose',
  'read', 'identify', 'collect', 'gather', 'record', 'report', 'implement', 'complete', 'finish', 'execute', 'include',
])

const ACTION_QUESTION = /^(?:can|could|would|will) you\b/i
/**
 * Addressed-to-the-assistant talk about ability, certainty or confidence. It is
 * a question about the agent, not work: "You're certain you can complete this
 * efficiently" was admitted as a task before this filter existed.
 */
const CAPABILITY = /\b(?:are|is|you're|you\s+are|you)\b[^.?!]{0,30}\b(?:certain|sure|confident|able|capable|willing)\b|\b(?:do|will) you (?:think|believe)\b/i
const REQUEST = /^(?:also|and|then|next|additionally|plus|finally|first)[,:]?\s+(?:please\s+)?(.+)$/i
const SOFT_REQUEST = /\b(?:i(?:'d| would)? (?:want|like|need) to|i (?:want|need) to|let'?s|we should|you should|can you|could you|would you|will you|please|also|need to)\s+(.+)$/i
const NEXT_STEP = /(?:next,?\s+(?:step:?\s+)?(?:we|you|i)\s+(?:will\s+|'ll\s+|need to\s+)?|you\s+(?:will|'ll|would|may|need to|'ll also need to)\s+(?:also\s+)?(?:need to\s+)?|we\s+(?:will|'ll|need to)\s+(?:also\s+)?(?:need to\s+)?|before\s+(?:that|you|installing|shipping)[,:]?\s+|the\s+next\s+step\s+(?:is\s+)?(?:to\s+)?|then\s+(?:we|you)\s+(?:need to\s+)?)(.{4,})$/i

/**
 * Text that reads as prose debris rather than a task worth tracking: code
 * spans, emphasis markers, arrows, parentheticals, bare one-word fragments.
 */
/** Work starts with an action, or a concrete prerequisite such as signing. */
export function isAcceptableTask(text) {
  const clean = String(text ?? '').trim().replace(/[*_\x60]/g, '')
  if (isFragment(clean) || CAPABILITY.test(clean)) return false
  if (/^(?:run|do|build|fix) (?:it|this|that|them|in |on |your recommendations|the recommendations)/i.test(clean)) return false
  const head = clean.toLowerCase().split(/[^a-z]+/)[0]
  return IMPERATIVES.has(head) || /^(?:signing|registration|provisioning profile|developer certificate)\b/i.test(clean)
}

export function isFragment(text) {
  const clean = String(text ?? '').trim()
  if (clean.length < 4 || clean.length > 2000) return true
  if (/[→|]/.test(clean) || /^(?:before answering|until then|still need|you're|you are)\b/i.test(clean)) return true
  if (/\b(?:and|or|with|for|of|to|by|from|into|until|when|covering|including)[,;:]?$|[,;:]$/.test(clean)) return true
  return false
}

function taskTitle(text) {
  text = text.replace(/^Analyze what you see and tell me (?:the )?/i, 'Analyze ').replace(/^Explain how you would do it differently[\s\S]*/i, 'Explain alternative steps and structure')
  if (text.length <= 100) return text
  const main = text.split(/,?\s+(?:covering|including|by doing|so that|and tell me|with particular attention to)\b/i)[0]
  if (main.length >= 12 && main.length <= 100) return main
  return text.slice(0, 98).replace(/\s+\S*$/, '') + '…'
}

const cleanObject = (s) =>
  String(s ?? '')
    .replace(/^(?:i|we|you|they)\s+(?:will\s+|would\s+|need to\s+|have to\s+|must\s+|should\s+|can\s+)?/i, '')
    .replace(/^(?:the|my|our|your|a|an)\s+/i, '')
    .replace(/\s+is$/i, '')
    .replace(/\s+(?:before|until|so that|so|which|that|because)\b.*$/i, '')
    .trim()

function sentenceCase(s) {
  const t = String(s).trim().replace(/^[,:\s]+/, '').replace(/[\s,;:]+$/, '')
  if (t.length === 0) return t
  return t[0].toUpperCase() + t.slice(1)
}

/**
 * Fold one conversation message into the document.
 *
 * @param {object} doc      checklist document (mutated in place)
 * @param {object} input    { role: 'user'|'assistant', text, seq }
 * @returns {{changed: boolean, added: number}}
 */
export function ingestMessage(doc, input) {
  const before = doc.tasks.length
  const sequence = doc.sequence
  const suggestions = doc.suggestions.length
  const { role = 'user', seq = null, text = '' } = input
  const sourceRef = seq === null ? null : `seq:${seq}`
  // A pasted document or a long instruction block is context, not a request
  // list: from one of those, only explicitly marked requests become tasks.
  // A directive turn is short. Pasted documents and multi-line instruction
  // blocks are context: only explicitly marked requests come out of them.
  // Measure what the user actually wrote: harness-injected reminders do not
  // make a one-line directive into a pasted document.
  const raw = stripInjected(text)
  const strict = raw.length > 300 || raw.split('\n').length > 3
  const clauses = splitClauses(raw)
  for (const [index, clause] of clauses.entries()) {
    // Assistant prose only contributes steps it states as necessary, or
    // confirms completion; it never becomes a task on its own initiative.
    if (role === 'assistant') ingestAssistantClause(doc, clause, seq, sourceRef)
    else ingestUserClause(doc, clause, seq, sourceRef, strict && index !== 0)
  }
  rollUpStatus(doc)
  return { changed: doc.sequence !== sequence || doc.suggestions.length !== suggestions, added: doc.tasks.length - before }
}

function ingestUserClause(doc, clause, seq, sourceRef, strict = false) {
  if (QUESTION.test(clause) && !ACTION_QUESTION.test(clause)) return
  if (CAPABILITY.test(clause)) return

  for (const re of RENAME) {
    const m = clause.match(re)
    if (!m) continue
    if (re === RENAME[0] || re === RENAME[1]) {
      const target = matchTask(doc, m[1])
      if (target) {
        renameTask(doc, target, sentenceCase(m[2]))
        return
      }
      continue
    }
    const focus = focusTask(doc)
    if (focus && renameTask(doc, focus, sentenceCase(m[1]))) return
  }

  for (const re of BLOCKED) {
    const m = clause.match(re)
    if (!m) continue
    const target = matchTask(doc, m[1])
    if (!target || target.manual?.status) continue
    const blocker = cleanObject(m[2])
    setStatus(doc, target, 'blocked', { blockedBy: sentenceCase(blocker) })
    // The dependency is itself work, and it belongs under the blocked outcome.
    addTask(doc, {
      text: sentenceCase(blocker),
      parentId: target.id,
      sourceSeq: seq,
      sourceRef,
    })
    return
  }

  for (const re of COMPLETION) {
    const m = clause.match(re)
    if (!m) continue
    const target = matchTask(doc, m[1])
    if (target) {
      completeTask(doc, target, { kind: 'user-confirmation', seq, reason: clause })
      return
    }
  }

  for (const re of CANCEL) {
    const m = clause.match(re)
    if (!m) continue
    const target = matchTask(doc, m[1])
    if (target) {
      setStatus(doc, target, 'dismissed')
      return
    }
  }

  for (const re of REOPEN) {
    const m = clause.match(re)
    if (!m) continue
    const target = matchTask(doc, m[1], { includeDismissed: true })
    if (target) {
      setStatus(doc, target, 'todo')
      return
    }
  }

  if (BRAINSTORM.test(clause) || HEDGES.test(clause)) {
    addSuggestion(doc, clause, seq, sourceRef, 'hedged')
    return
  }

  const stepMatch = clause.match(REQUEST)
  const soft = clause.match(SOFT_REQUEST)
  const phrase = stepMatch?.[1] ?? soft?.[1] ?? (ACTION_QUESTION.test(clause) ? clause.replace(ACTION_QUESTION, '').trim() : null)
  if (phrase !== null && /^(?:run|do|apply) (?:it|this|that|them|your recommendations|the recommendations)\b/i.test(phrase)) {
    addSuggestion(doc, phrase, seq, sourceRef, 'needs-context')
    return
  }
  if (phrase === null) {
    // A bare imperative ("Install DSH on my iPad.") is a request; a statement
    // that merely opens with a noun ("Approval prompts are disabled here") is not.
    const words = clause.split(/\s+/)
    const first = (words[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
    if (strict) return
    if (IMPERATIVES.has(first) && words.length <= 180 && !/\b(?:is|are|was|were|has|have)\b/i.test(clause.slice(0, 40))) {
      placeTask(doc, sentenceCase(clause), seq, sourceRef)
    }
    return
  }
  placeTask(doc, sentenceCase(phrase), seq, sourceRef, {
    separate: /^(?:also|plus|additionally)\b/i.test(clause),
    sequencing: /^(?:then|next|first|finally)\b/i.test(clause),
  })
}

function ingestAssistantClause(doc, clause, seq, sourceRef) {
  if (QUESTION.test(clause)) return
  const focus = focusTask(doc)
  if (focus === null) return

  if (clause.length > 140 || /[`*|]/.test(clause)) return
  const next = clause.match(NEXT_STEP)
  if (next) {
    const phrase = sentenceCase(cleanObject(next[1]))
    // A hedge is a proposal for the user to judge, not a task we assert.
    if (HEDGES.test(clause)) {
      addSuggestion(doc, phrase, seq, sourceRef, 'hedged')
      return
    }
    const head = (phrase.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
    if (isFragment(phrase) || phrase.split(/\s+/).length < 3 || !IMPERATIVES.has(head)) return
    addTask(doc, { text: phrase, parentId: focus.id, sourceSeq: seq, sourceRef })
    return
  }

  // "The app needs signing." — a requirement the assistant states about the
  // object of the current outcome becomes a step under it.
  const needs = clause.match(/^(?:the\s+|your\s+|our\s+)?(.+?)\s+(?:needs|requires|must have)\s+(.+)$/i)
  if (needs && !HEDGES.test(clause)) {
    const object = sentenceCase(cleanObject(needs[2]))
    // A requirement named in passing is still a sentence, not a bullet fragment.
    if (object.length >= 5 && object.length <= 60 && !/\s(?:and|or|because|which|that)\s/i.test(object)) {
      addTask(doc, { text: object, parentId: focus.id, sourceSeq: seq, sourceRef })
    }
    return
  }

  // A free-form assistant assertion alone cannot establish completion.
}

function placeTask(doc, text, seq, sourceRef, { separate = false, sequencing = false } = {}) {
  if (text.trim().length === 0) return null
  if (isFragment(text)) return null
  // Replay guard: re-reading the same message must return the row it made, not
  // a second copy under a different parent.
  const normalized = text.trim().toLowerCase()
  const already = doc.tasks.find(
    (t) => t.text.trim().toLowerCase() === normalized || (t.autoText ?? '').trim().toLowerCase() === normalized,
  )
  if (already) return already
  const focus = focusTask(doc)
  const probe = tokens(text)
  const skip = ubiquitous(doc.tasks.map((t) => t.text))
  let parentId = null

  if (focus !== null) {
    const related = score(probe, tokens(focus.text), skip)
    // "Also …" names a separate outcome; sequencing or a related object is a step.
    if (!separate && (sequencing || related >= 0.5)) parentId = focus.id
  }

  const task = addTask(doc, { text, parentId, sourceSeq: seq, sourceRef })
  if (task && parentId === null) {
    // A new top-level outcome becomes the focus for the steps that follow it.
    task.sequence = nextSequence(doc)
  }
  return task
}

function addSuggestion(doc, text, seq, sourceRef, reason) {
  const clean = sentenceCase(text.replace(/^(?:you (?:may|might) want to|you could|consider|optionally|maybe)\s*/i, ''))
  if (clean.length < 4 || isFragment(clean)) return
  if (clean.split(/\s+/).length < 3) return
  if (doc.suggestions.filter((s) => s.sourceSeq === seq).length >= 3) return
  const id = suggestionId(clean, seq)
  if (doc.dismissedSuggestions?.includes(id)) return
  if (doc.suggestions.some((s) => s.id === id)) return
  const focus = focusTask(doc)
  doc.suggestions.push({
    id,
    text: clean,
    parentId: focus?.id ?? null,
    sourceSeq: seq,
    sourceRef,
    reason,
    createdAt: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// DSH native plan (supplemental input)
// ---------------------------------------------------------------------------

export function ingestNativePlan(doc, event) {
  const data = event?.data
  if (!data || (event.type !== 'todo/write' && (event.type !== 'tool/call' || data.name !== 'todo_write'))) return false
  let payload = data
  if (event.type === 'tool/call') {
    try {
      payload = JSON.parse(data.arguments)
    } catch {
      return false
    }
  }
  const list = Array.isArray(payload?.todos) ? payload.todos : null
  if (list === null) return false
  doc.nativePlan = {
    source: 'todo_write',
    seq: event.seq,
    todos: list.slice(0, 40).map((t, index) => ({
      id: String(t?.id ?? index),
      content: String(t?.content ?? '').slice(0, 300),
      status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
      sourceSeq: event.seq,
      sourceRef: `seq:${event.seq}`,
    })),
  }
  return true
}

/** DSH's goal tools describe the same outcome at a coarser grain. */
export function ingestGoal(doc, event) {
  const data = event?.data
  if (!data || event.type !== 'tool/call') return false
  if (data.name !== 'create_goal' && data.name !== 'update_goal') return false
  let payload
  try {
    payload = JSON.parse(data.arguments)
  } catch {
    return false
  }
  if (typeof payload?.objective !== 'string') return false
  doc.nativePlan = {
    ...(doc.nativePlan ?? { todos: [] }),
    goal: { objective: payload.objective, seq: event.seq, sourceRef: `seq:${event.seq}` },
  }
  return true
}

// ---------------------------------------------------------------------------
// Roll-up view for the Client
// ---------------------------------------------------------------------------

export function project(doc) {
  const byParent = new Map()
  for (const task of doc.tasks) {
    if (!byParent.has(task.parentId)) byParent.set(task.parentId, [])
    byParent.get(task.parentId).push(task)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sequence - b.sequence)
  const visible = doc.tasks.filter((t) => t.status !== 'dismissed')
  return {
    sessionId: doc.sessionId,
    updatedAt: doc.updatedAt,
    processedSeq: doc.processedSeq,
    tracking: doc.tracking !== false,
    migrationPending: doc.extractorVersion !== EXTRACTOR_VERSION,
    counts: {
      total: visible.length,
      open: visible.filter((t) => t.status === 'todo' || t.status === 'doing').length,
      done: visible.filter((t) => t.status === 'done').length,
      blocked: visible.filter((t) => t.status === 'blocked').length,
      suggestions: doc.suggestions.length,
      dismissed: doc.tasks.length - visible.length,
    },
    tasks: doc.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      text: task.text,
      description: task.description ?? task.autoText ?? task.text,
      status: task.status,
      blockedBy: task.blockedBy,
      sourceRef: task.sourceRef,
      origin: task.origin,
      completedBy: task.completedBy ?? null,
      childCount: (byParent.get(task.id) ?? []).filter((t) => t.status !== 'dismissed').length,
    })),
    suggestions: doc.suggestions,
    nativePlan: doc.nativePlan,
  }
}
