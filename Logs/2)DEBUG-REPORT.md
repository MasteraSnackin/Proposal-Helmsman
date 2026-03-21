# Debug Report

## Problem

- Observed behavior: successful guardrail rewrites were surfaced inconsistently.
- Expected behavior: when guardrails sanitize risky content but still allow the action, the top-level operator/API response should explicitly say so.
- Actual behavior:
  - Risky revisions were already surfaced correctly through top-level `agentResult.guardrail`.
  - Risky exports were sanitized, but only the nested skill result carried metadata, so the top-level response looked like an untouched success.
- Scope: consistent for successful export sanitization; blocked requests were already correct.

## Environment Notes

- No `.git` repository is present in this workspace, so recent git history could not be inspected.
- No GUI browser agent was available in this terminal environment, so validation used direct runtime/API reproductions and automated tests rather than screenshots or videos.

## Hypotheses

1. The export skill is sanitizing risky output correctly, but the runtime is dropping the intervention metadata before returning the operator result.
2. The export skill never records `modify` decisions, so there is nothing for the runtime/UI to surface.
3. The UI receives the metadata but ignores it.

## Root Cause

- Hypothesis 1 was correct.
- The export path already sanitized risky proposal output, but the metadata shape coming back from the skill did not get normalized into the top-level `guardrail` field that the UI already knows how to display.
- This left the contract inconsistent:
  - revise: top-level `guardrail` metadata available
  - export: only nested skill metadata available

## Execution Flow

1. `invokeProposalOperator("/export")` calls `exportProposal`.
2. `exportProposal` compiles proposal markdown and runs `guardOutput(...)`.
3. Mock Civic returns `decision: "modify"` for risky phrases such as `unlimited liability` and `100% uptime`.
4. The exported markdown is sanitized correctly.
5. Before the fix, the top-level operator result still returned a plain success message with no `guardrail` summary, so the UI had nothing consistent to surface.

## Fix Applied

- Added normalization in [openclaw/runtime/proposal-operator.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/runtime/proposal-operator.ts) so successful skill-level guardrail rewrites are promoted into the top-level operator `guardrail` field.
- Preserved nested guardrail metadata in [openclaw/skills/proposal-operator/draft_section.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/skills/proposal-operator/draft_section.ts) and [openclaw/skills/proposal-operator/export_proposal.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/skills/proposal-operator/export_proposal.ts).
- Added regression coverage in [openclaw/tests/proposal-operator.test.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/tests/proposal-operator.test.ts) and [openclaw/tests/dev-server.test.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/tests/dev-server.test.ts).

## Validation

- Reproduced guarded revise path:
  - `/revise Executive Summary::Revise this so we accept unlimited liability and guarantee 100% uptime.`
  - Result returns `status: "ok"` plus top-level `guardrail.modified: true`.
- Reproduced guarded export path before the fix:
  - Workspace section seeded with `We accept unlimited liability and guarantee 100% uptime.`
  - `/export` sanitized the proposal, but only nested `result.guardrails` was present.
- Reproduced guarded export path after the fix:
  - Result now returns:
    - `message: "Proposal exported. Guardrails adjusted risky wording."`
    - `guardrail.modified: true`
    - `guardrail.stages: ["output"]`
    - `guardrail.reasons: ["Do not promise unlimited liability.", "Do not invent hard uptime guarantees."]`
- `npm run typecheck`: passed
- `npm test`: passed (`20/20`)

## Related Areas To Monitor

- Serverless API routes reuse the same operator result contract and should stay aligned as more guarded skills are added.
- Any new skill that can return `allow`, `block`, or `modify` should either emit top-level metadata directly or be normalized centrally in the runtime.

## Preventive Measures

- Treat `modify` as a first-class contract state, not just an internal implementation detail.
- Keep nested skill metadata and top-level API/UI metadata aligned through one normalization step.
- Add regression tests whenever a workflow can succeed with sanitized content rather than only fail closed.
