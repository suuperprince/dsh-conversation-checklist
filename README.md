# dsh-conversation-checklist

Turns the active conversation into a live checklist in DeepSeek Harness.

- **Beside the composer:** a three-line button (`conversation.input.left`) opens a compact checklist anchored above the composer (`conversation.input.overlay`). It closes on a second click, a click outside, Escape, or a conversation switch, and never blocks the chat input.
- **Per conversation:** both slots are Session-scoped, so the shell supplies the stable session id; tasks, subtasks, status, provenance and sync checkpoints are keyed by it alone.
- **Automatic:** committed session events drive the document, and the open panel refreshes itself. Sub-task completion, blockers and cancellations from the conversation update it without a refresh or a command.
- **Read-only panel:** the checklist reports state; it has no rename, complete, reopen or dismiss controls, and those HTTP actions return 403. Lifecycle comes from the conversation.
- **Completion on evidence:** a task is checked off only for a verified success, or for an explicit confirmation in chat. Failed, interrupted and partial work stays open.
- **Rules, and how strict they are:** see [Completion rules](#completion-rules).

Built and verified against **DSH 0.2.2-rc.3** (profile `desktop`). Requires DSH `>=0.2.2-rc.3 <0.3.0-0`. It uses only supported APIs: `ctx.on('session/event')`, `ctx.sessions`, `ctx.webServer.register`, and the Client `slots` / `sessions` services. It never appends session events, never patches core, and never reads another plugin's DOM.

## Install

Requirements: DSH 0.2.2-rc.3 or newer (below 0.3), and a writable `$DSH_HOME` (checklists live in `$DSH_HOME/plugin-data/dsh-conversation-checklist/`).

**From a GitHub release (recommended).** Download the `.tgz` from the release page, then in DSH open **Plugins → Add plugin** and paste its URL:

```
https://github.com/suuperprince/dsh-conversation-checklist/releases/latest/download/dsh-conversation-checklist-1.1.0.tgz
```

**From the repository** (tracks the default branch):

```
dsh plugin --profile <profile> add github:suuperprince/dsh-conversation-checklist
```

or, with the agent's `plugin_manager` tool:

```
plugin_manager action=install_bundle target=github:suuperprince/dsh-conversation-checklist
```

**From npm**, once published:

```
dsh plugin --profile <profile> add dsh-conversation-checklist
```

Open any conversation afterwards: the three-line button appears in the composer tool row. If a row for this bundle was already loaded, reload the window so the fresh client module is used.

## Completion rules

A task becomes `done` only through one of these paths, and each records provenance (`kind`, session, event seq, a short reason) that the panel shows on hover:

| Evidence | Fires when |
| --- | --- |
| `tests` | a test command ran and the result reports passing tests |
| `signing` | a `codesign` verify/sign succeeded |
| `write` | a file-write tool reported the write |
| `native-plan` | DSH's own plan marks that exact item completed |
| `execution` | a shell command reported exit 0 (plain `bash` `[exit: 0]`, or a `run_code` wrapper whose nested exit code is 0) and exactly one open task shares its object |
| `model mapping` | `mapCompletion` asks a model *which* open task a verified exit-0 command finishes; the engine still owns the success predicate |
| `user-confirmation` | you say in chat that a task is finished |
| `assistant-verified` | `proseCompletion`: the assistant says the work is finished, verified or confirmed, naming that task's object |

`assistant-verified` is deliberately narrow, because prose is the weakest evidence: the sentence must be ≤140 characters, carry an explicit completion verb, share ≥60% of the task's words, and not be a question, a hedge or a future claim (“will”, “should”, “not yet”, “still”), a bullet, or an evidence dump. Destructive or external outcomes (deploy, release, delete, pay) additionally need an explicit “verified / confirmed / checked”. Tasks you set by hand are never overwritten, and an ambiguous match closes nothing.

Ordering matters: code always decides *whether* a success exists; the model, when enabled, only decides *which* task it belongs to.

## Remove

```
plugin_manager action=remove_bundle target=dsh-conversation-checklist
```

Or **Plugins → Installed → dsh-conversation-checklist → uninstall**. Deleting `$DSH_HOME/plugin-data/dsh-conversation-checklist/` removes the stored checklists too; nothing else is left behind.

## Configuration

The bundle's row in `~/.dsh/profiles/<profile>/cordis.patch.yml` carries the options:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Load the plugin at all. |
| `extraction` | `rules` | `rules` — deterministic, no model call. `model` — route each new message through a model. |
| `maxTasks` | `300` | Upper bound; the oldest dismissed rows are dropped first. |
| `model.provider` / `model.model` | `''` | Explicit route. Empty means "use the profile's default route" (`agentDefaultModel.currentSelection()`), resolved only when `extraction: model`. |
| `model.maxChars` | `4000` | How much of the new message is sent. Never the whole transcript. |
| `dataDir` | `$DSH_HOME/plugin-data` | Parent of the plugin's data directory. |

### The model is opt-in

The default extractor is deterministic: no model, no network, no cost. Set `extraction: model` to use a configured route instead. In that mode only the new message plus the current task titles are sent, the call runs after `turn/end` (never in front of the reply), and any failure falls back to the deterministic rules.

## What it tracks

Each task has a stable id, an optional parent id, a status (`todo` / `doing` / `blocked` / `done` / `dismissed`), a `blockedBy` reason, and a `seq:<n>` source reference to the message that created it.

- A necessary step lands under the outcome it serves; a separately requested outcome becomes its own top-level task.
- Brainstorming and questions are ignored; hedged proposals become suggestions you accept or dismiss.
- Corrections rename, cancellations dismiss, reopenings return to `todo`.
- Signed-off work completes when you confirm it or concrete execution evidence establishes the result.
- Blocked work stays visible with its dependency named, and the dependency is tracked under it.
- Rename, check off, reopen and dismiss from the panel; a manual change is never overwritten by a later sync.

When a turn uses DSH's own `todo_write` or goal tools, that plan is shown as **DSH native plan** — supplemental input, never merged automatically.

## Tests

```
npm test        # or: node --test test/*.test.mjs
```

69 tests. `test/engine.test.mjs` covers extraction rules, completion evidence (tests, signing, file writes, native plans, `run_code` and plain `bash` exit 0, model mapping) and its refusals; `test/host.test.mjs` drives the real `apply()` through session events and the HTTP routes; `test/store.test.mjs` covers persistence and isolation.

## Limits

- The plugin tracks tasks; it never executes one.
- Conversation text is data, never instructions.
- iOS behaviour is untested by this build; see `docs/DETAIL.md` and the verification report.
