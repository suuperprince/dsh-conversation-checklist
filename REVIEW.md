# Conversation checklist 1.0.2

The patch fixes automatic completion routing and task extraction in the installed 1.0.1 code. It preserves the existing composer button and panel fixes.

Changes include receiving the originating session on live tool-result events, linking results to committed calls, rejecting read-only tool results as completion, retaining evidence for completion and removing it when reopened, accepting exact native-plan completion updates, rejecting screenshot fragments and capability questions, storing full descriptions behind short titles, and versioning checklist re-extraction correctly.

Older checklists rebuild from available conversation history with a backup created before migration. Manual task edits and accepted items survive. Missing history is reported as reassessment pending. Optional model proposals pass task validation and cannot check off work without existing completion evidence.

Verification includes 46 passing tests and syntax checks. The tests cover the actual live event entry point, successful and failed execution, incomplete execution, read-only results, false-task examples, parent/subtask independence, manual status protection, restart persistence, migrations and per-session isolation. Replay of 20 saved session logs removed the screenshot's false commentary and capability items. The larger screenshot session changed from 131 automatic entries to 91 entries, with actionable requests retained from that chat.

Execution completion currently supports passing test commands, signing verification, linked file writing, and exact native-plan completion updates. A successful arbitrary command does not establish a whole goal. Ambiguous work remains open for user confirmation. General semantic understanding still depends on the optional model extractor and its configured route.

Deployment was attempted and rejected by the managed execution policy. The installed plugin is unchanged. Live UI behavior of this patch remains unverified. The prepared deploy-fix.py checks baseline hashes before changing installed files, creates a plugin and data backup, then replaces only the reviewed files.

To apply using an environment authorized to write the installed directory, run python3 deploy-fix.py from this extracted directory. Reload the checklist plugin afterward. The DSH desktop application currently has unrelated active work, so use plugin-level reload controls instead of restarting the entire application during that work.
