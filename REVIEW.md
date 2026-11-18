# DSH conversation checklist review

## Source examined

Installed local bundle at /Users/rotimiadedeji/dsh-plugins/dsh-conversation-checklist.
The desktop profile links to that directory.
Matched the original session by its recorded title, “Build an installable DeepSeek Harness”, and replayed its 2,533 event records locally.

## Confirmed defects and fixes

- Runtime-generated user-role messages were mined for tasks. Extraction now checks message provenance.
- Wrapped requests lost their primary task, while acceptance examples became real tasks. Wrapped prose is joined and explicitly labelled scenario paragraphs and code blocks are excluded.
- Polite action requests starting with “could you” were discarded as questions.
- Existing persisted sessions skipped events missed during downtime. Opening or receiving the next event now catches up from the stored sequence.
- Status-only changes could return changed=false and fail to persist. Change detection uses mutation sequence and suggestion count.
- Native-plan ingestion required a nonexistent data.type field. It now supports the committed event shapes.
- Rebuild deleted manual edits. Manual statuses, renames, retained tasks and dismissed suggestions now survive reconstruction.
- Old extracted documents retain false tasks indefinitely. Versioned re-extraction cleans automatic derivations when full session history is available and tracking is enabled, preserving manual edits.
- Automated model operations used manual-edit operations, overwrote manual status and created manual locks. They now use automated mutations.
- Slow or repeated model jobs could apply obsolete results. Per-session job identity, sequence checks and tracking checks reject them.
- Model context omitted the assistant's finalized reply and task parent relationships. These now accompany the originating human message.
- Completing a prerequisite could complete the entire parent outcome. It now clears the blocker and leaves the outcome open.
- Returning A → B → A could admit stale stream or action responses. Client generations reject earlier visits.
- A disconnected stream could leave a silently stale checklist. The panel now reports reconnection.
- Stream cleanup watched the request lifecycle. It now watches the response lifecycle.
- Corrupt file handling removed the original before preserving it. Corrupt files are now renamed first.
- The test script depended on directory discovery. It now explicitly includes test files.

## Verification

42 automated tests pass. Includes host event handling, persistence, restart catch-up, session isolation, delayed model responses, rebuild preservation, extraction provenance, real native-plan shape, and a VM-executed browser-store A-B-A regression.
JavaScript syntax checks pass.
Original-chat replay recovered the main build request and removed the false iPad-installation, backup, signing, and test-instruction tasks.

## Remaining validation and limitations

The patched bundle has not been installed in the running desktop app. The execution sandbox rejects writes to its existing installed directory. A read-only write probe confirmed the restriction.
The native desktop interface was inspected, but patched icon clicks, panel layout, real session switching, live model extraction, and restart behavior were not verified in the running application.
Rule extraction remains heuristic. General semantic understanding requires the existing optional model extraction mode and a verified route. This patch leaves the configured rules mode in place and adds no model-call cost.
Automatic completion from arbitrary execution-tool results remains incomplete. Conservative completion handling avoids checking tasks off based solely on assistant prose.
All testing and replay used a workspace copy. Existing sessions, saved checklists and the installed plugin remain untouched.

## Applying the patch

Run install-fix.sh from this extracted directory after closing DSH.
It verifies the original files have not changed, backs up only replaced files, and copies this patch into the existing linked bundle. Then reopen DSH.
On first access, old automatic extractions rebuild from available session history while preserving manual edits. Automatic rebuilding waits while tracking is paused.
