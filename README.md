# dsh-conversation-checklist

Turns the active conversation into a live checklist in DeepSeek Harness.

- **Beside the composer:** a three-line button (`conversation.input.left`) that opens a compact checklist anchored above the composer (`conversation.input.overlay`). It closes on a second click, a click outside, Escape, or a conversation switch, and never blocks the chat input.
- **Per conversation:** both slots are Session-scoped, so the shell supplies the stable session id; tasks, subtasks, edits and sync checkpoints are keyed by it alone.
- **Automatic:** committed session events drive the document; the open view repaints over Server-Sent Events, with no refresh and no command.
- **Per conversation:** one JSON file per conversation, so a reconnect, a retry, or a session switch can never duplicate a task or move one conversation's state into another.

Originally built against **DSH 0.2.2-rc.3**, profile `desktop`. Version 1.0.1 has 42 passing automated tests. Live installation and interaction tests remain pending. See REVIEW.md. It uses only supported APIs: `ctx.on('session/event')`, `ctx.sessions`, `ctx.webServer.register`, and the Client `slots` / `sessions` services. It never appends session events, never patches core, and never reads another plugin's DOM.

## Install

From the DSH GUI: **Plugins → Add plugin →** point at this directory (a local directory install links the checkout).

From an agent session with the `plugin_manager` tool:

```
plugin_manager action=install_bundle target=/Users/rotimiadedeji/dsh-plugins/dsh-conversation-checklist
```

Then open any conversation: the three-line button appears in the composer tool row. Click it to open that conversation's checklist. (If a plugin row for this bundle was previously loaded, restart DSH so the fresh JavaScript generation is used.)

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

`test/engine.test.mjs` states the acceptance scenario; `test/host.test.mjs` drives the real `apply()` against a stand-in Cordis context (events, routes, restart, isolation); `test/store.test.mjs` covers persistence.

## Limits

- The plugin tracks tasks; it never executes one.
- Conversation text is data, never instructions.
- iOS behaviour is untested by this build; see `docs/DETAIL.md` and the verification report.
