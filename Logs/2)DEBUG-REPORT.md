# Debug Report

## Problem

- Observed behavior: failed operator requests could leave stale optimistic draft/export placeholders visible in the UI, and the dashboard still allowed overlapping operator actions while one request was in flight.
- Expected behavior: if an operator request fails, the UI should clear any optimistic placeholder and rerender the real workspace state alongside the error notice, and it should prevent another operator action from starting until the current one finishes.
- Actual behavior:
  - `runDraft`, `runRevision`, and `runExport` set optimistic placeholder content before the request.
  - On request failure, the error path showed a notice and toast, but it did not clear `state.optimistic` or rerender the previews.
  - That left the section or proposal preview stuck on "Applying revision safely..." or "Assembling proposal draft..." even though the action had failed.
  - Only the clicked action button entered a busy state, so another operator action could still be triggered before the first request settled.
- Scope: consistent for operator-request failures in the draft, revise, and export flows, with overlapping-action races possible from the UI whenever a dependent action was triggered too quickly.

## Environment Notes

- Recent git history was inspected. The only recent commit was documentation-only: `e87124b docs: refresh README and architecture guide`.
- No GUI browser agent is available in this terminal environment, so validation used a targeted UI harness plus the existing automated test suite instead of screenshots or videos.

## Hypotheses

1. `sendOperatorMessage(...)` handles errors without clearing optimistic UI state or rerendering the preview panes.
2. The preview renderers keep preferring optimistic state even after the request fails because nothing invalidates it.
3. The request state is tracked per button instead of per operator workflow, so overlapping actions can race each other.

## Root Cause

- Hypotheses 1 and 3 were correct.
- The UI had two request-state gaps in [web/app.js](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/web/app.js):
  - optimistic placeholders were only cleared on successful operator responses
  - request locking only applied to the clicked button, not to the wider operator workflow
- In the error path inside `sendOperatorMessage(...)`, the UI called `reportUiError(...)` and returned, but never reset `state.optimistic` and never called `render()`.
- Separately, because other operator controls remained interactive during an in-flight request, a second action could be triggered against stale workspace state before the first write completed.

## Execution Flow

1. `runDraft()`, `runRevision()`, or `runExport()` writes optimistic preview text into `state.optimistic` and calls `render()`.
2. `sendOperatorMessage(...)` starts the API request.
3. If `fetchJson(...)` throws, the `catch` block reports the UI error but previously did not reset optimistic state.
4. The preview panes therefore kept rendering the old optimistic content instead of the last real workspace content or empty state.
5. While that request is still in flight, other operator controls were previously still clickable, so a fast follow-up action could race the first request and hit stale server state.

## Fix Applied

- Added `resetOptimisticState()` in [web/app.js](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/web/app.js) and reused it after successful operator responses.
- Updated the `sendOperatorMessage(...)` failure path in [web/app.js](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/web/app.js) to:
  - clear optimistic state
  - report the error
  - rerender the UI
- Added `notifyOperatorBusy()` plus `setDashboardInteractionLocked(...)` in [web/app.js](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/web/app.js) so parse/plan/coverage/draft/revise/export and related dashboard controls are temporarily disabled while an operator request is running.
- Added regression coverage in [openclaw/tests/web-app.test.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/tests/web-app.test.ts) to verify that failed operator requests clear optimistic placeholders and rerender the UI.

## Validation

- `npm run typecheck`: passed
- `npm test`: passed (`21/21`)
- New regression test confirms:
  - optimistic section/proposal placeholders are cleared on request failure
  - the UI rerenders after the failure
  - the notice, toast, and activity log still reflect the request error
- Live local bundle verification confirmed the updated UI now serves `resetOptimisticState()`, `notifyOperatorBusy()`, and `setDashboardInteractionLocked(...)`.

## Related Areas To Monitor

- Any future UI flow that preloads optimistic content should use the same reset path on failures.
- Download and workspace-management flows already use separate handlers; if they add optimistic rendering or async chaining later, they should follow the same failure-reset and request-lock pattern.

## Preventive Measures

- Treat optimistic UI state as transactional: set it before the request, then always clear it on both success and failure.
- Treat operator requests as a single in-flight workflow, not as isolated button states, when actions depend on shared workspace files.
- Keep small UI-state regression tests near the existing Node test suite when browser automation is unavailable.
