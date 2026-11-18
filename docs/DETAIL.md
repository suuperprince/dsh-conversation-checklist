# Conversation checklist

Turns one conversation into a task checklist and keeps it current.

## Where it appears

- **Beside the composer:** a small three-line button in the composer tool row (`conversation.input.left`), labelled "Conversation checklist" for assistive technology and with a visible keyboard focus ring.
- **Anchored panel:** clicking it opens a compact panel above the composer (`conversation.input.overlay`, where DSH's own slash menu and command popup live). It closes on a second click, on a click outside, on Escape, and when the conversation changes. It is non-modal: the composer keeps focus and stays usable, and clicking into it closes the panel.

## What it tracks

Each task has a stable id, an optional parent id, a status (`todo`, `doing`, `blocked`, `done`, `dismissed`), what it is waiting for when blocked, and a `seq:<n>` reference to the message that created it.

- A step the conversation establishes as necessary lands under the outcome it serves; a separately requested outcome becomes its own top-level task.
- Brainstorming and questions are ignored; hedged proposals become suggestions you accept or dismiss.
- Corrections rename, cancellations dismiss, and reopened items return to `todo`.
- A task is completed when you confirm it or the conversation establishes a reliable result.
- Blocked tasks stay visible with their dependency named, and the dependency is tracked under them.

## How completion is decided

A task is closed only by evidence, never by turn completion or by the mere act of trying. Supported evidence: a passing test result, a successful signing check, a reported file write, an exact native-plan completion, a shell command that exited 0 and names the task's object, an assistant sentence that reports the work finished (guarded: no questions, hedges, future claims, bullets or evidence dumps; destructive outcomes need an explicit verification), or your own statement in chat.

Automated closure never overrides a status you set by hand, and an ambiguous match leaves the task open on purpose. Every closure stores its provenance — kind, session, event sequence and a short reason — so a checked row can be explained later.

## Manual edits

Rename, check off, reopen, and dismiss from the panel. A manual change is remembered and later syncs do not overwrite it.

## Per-conversation binding

Both composer slots are Session-scoped, so DSH hands the button and the panel the stable session id of the conversation on screen. Every read, write, stream and stored file is keyed by that id — never by the title, the workspace path, or the selected chat. Each model analysis is bound to its originating session before its first await, and is discarded if that session's document was replaced (rebuild, reload) while it ran.

## Persistence

One JSON file per conversation under `$DSH_HOME/plugin-data/dsh-conversation-checklist/`. A conversation's document can only be read or written by that conversation, so a reconnect, retry, or session switch cannot duplicate tasks or cross-apply one conversation's state to another. Writes are atomic and serialized per conversation.

## DSH's own plan

When a turn uses DSH's `todo_write` or `create_goal` tool, that plan is shown as supplemental input under **DSH native plan**; each entry can be added to the checklist. It is never merged automatically.

## Extraction cost

Extraction runs on committed session events, after the turn is already durable, so it never blocks the chat. The default extractor is deterministic: no model call, no network. Setting `extraction: model` in the plugin's configuration (or in `cordis.patch.yml`) routes each new message through a model route the profile already configured — only that message and the current task titles are sent — and falls back to the deterministic rules when the call fails or the reply is unusable.

## Limits

- The plugin tracks tasks; it never executes one.
- Conversation text is treated as data, never as instructions.
- iOS behaviour is not covered by this build; see the verification report for exactly what was and was not exercised.
