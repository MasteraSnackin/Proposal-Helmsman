import assert from "node:assert/strict";
import test from "node:test";

import {
  findRequirementEvidence,
  findRequirementEvidenceInPreparedSections,
  prepareCoverageSections
} from "../skills/proposal-operator/shared.ts";

test("prepared coverage sections preserve requirement evidence matches", () => {
  const sections = [
    {
      fileName: "executive_summary.md",
      content: [
        "We summarise pasted tender text, identify required and optional criteria, and outline the full response structure.",
        "Slack threads remain linked to auditable workspaces for proposal operations."
      ].join("\n\n")
    },
    {
      fileName: "delivery_plan.md",
      content: [
        "Security, privacy, and commercial prudence remain review-first throughout delivery.",
        "No fixed pricing or unlimited liability guarantees are introduced."
      ].join("\n\n")
    }
  ];
  const requirement =
    "The system must summarise pasted RFP text, extract mandatory and optional requirements, plan proposal structure, and support Slack thread workspaces.";

  const directEvidence = findRequirementEvidence(requirement, sections);
  const preparedEvidence = findRequirementEvidenceInPreparedSections(
    requirement,
    prepareCoverageSections(sections),
  );

  assert.deepEqual(preparedEvidence, directEvidence);
});
