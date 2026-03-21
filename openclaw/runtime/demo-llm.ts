import type { GenerateOptions, LlmClient } from "./types.ts";

type RequirementStub = {
  id: string;
  text: string;
  must_have: boolean;
};

export function createDemoLlm(): LlmClient {
  return {
    async generate<T = unknown>(options: GenerateOptions): Promise<
      | T
      | string
      | {
          json?: T;
          text?: string;
          content?: string;
          output_text?: string;
        }
    > {
      const task = detectTask(options.system, options.prompt);

      switch (task) {
        case "parse_rfp":
          return renderForMode(buildParsedRfp(options.prompt) as T, options);
        case "plan_proposal_structure":
          return renderForMode(buildProposalStructure() as T, options);
        case "draft_section":
          return buildDraftSection(options.prompt);
        case "revise_section":
          return reviseDraftSection(options.prompt);
        default:
          return options.output?.format === "json"
            ? { text: JSON.stringify({ ok: true }) }
            : "Demo LLM fallback output.";
      }
    }
  };
}

function detectTask(system: string, prompt: string): string {
  const combined = `${system}\n${prompt}`;
  const match = combined.match(/TASK=([a-z_]+)/);
  return match?.[1] ?? "unknown";
}

function renderForMode<T>(value: T, options: GenerateOptions): T | string {
  if (options.output?.format === "json") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function buildParsedRfp(prompt: string): {
  summary: string;
  requirements: RequirementStub[];
} {
  const rfpText = extractTag(prompt, "rfp_text") ?? prompt;
  const normalized = rfpText.replace(/\s+/g, " ").trim();
  const sentences = splitSentences(normalized);
  const lines = rfpText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const summary = sentences.slice(0, 4).join(" ") || normalized;
  const candidates = Array.from(
    new Set(
      [...lines, ...sentences].filter((entry) =>
        /(must|should|required|shall|need|expects?|security|privacy|timeline|delivery|compliance|proposal|support|experience)/i.test(
          entry,
        ),
      ),
    ),
  ).slice(0, 12);

  const requirements = (candidates.length > 0 ? candidates : sentences.slice(0, 6)).map(
    (candidate, index) => {
      const cleaned = candidate.replace(/^[\-\*\d\.\)\s]+/, "").trim();
      return {
        id: `${toSnakeCase(cleaned.split(/\s+/).slice(0, 3).join(" ")) || "requirement"}_${index + 1}`,
        text: cleaned,
        must_have: /\b(must|required|shall|mandatory)\b/i.test(cleaned)
      };
    },
  );

  return {
    summary,
    requirements
  };
}

function buildProposalStructure(): {
  sections: Array<{ name: string; order: number }>;
} {
  return {
    sections: [
      { name: "Executive Summary", order: 1 },
      { name: "Understanding of Requirements", order: 2 },
      { name: "Proposed Solution", order: 3 },
      { name: "Delivery Plan", order: 4 },
      { name: "Team and Relevant Experience", order: 5 },
      { name: "Data Privacy and Security", order: 6 },
      { name: "Commercials and Assumptions", order: 7 }
    ]
  };
}

function buildDraftSection(prompt: string): string {
  const sectionName = extractTag(prompt, "section_name") ?? "Proposal Section";
  const emphasis = extractTag(prompt, "emphasis");
  const rfpSummary =
    extractTag(prompt, "rfp_summary") ?? "The client is seeking a capable delivery partner.";
  const requirements = parseRequirements(extractTag(prompt, "requirements_json"));
  const mustHaveText =
    requirements
      .filter((requirement) => requirement.must_have)
      .slice(0, 3)
      .map((requirement) => requirement.text)
      .join("; ") || "the stated requirements";

  const emphasisSentence = emphasis
    ? `We have placed particular emphasis on ${emphasis.toLowerCase()}.`
    : "";

  switch (sectionName.toLowerCase()) {
    case "executive summary":
      return [
        `We understand that this opportunity requires a response that is practical, credible, and aligned to the stated outcomes in the RFP. ${rfpSummary}`,
        `Our approach is to translate the requirement set into a delivery plan that addresses ${mustHaveText} while keeping governance, risk, and stakeholder visibility clear throughout the engagement.`,
        emphasisSentence ||
          "This draft is designed as a reviewable starting point that can be refined with commercial details and client-approved commitments."
      ]
        .filter(Boolean)
        .join("\n\n");
    case "understanding of requirements":
      return [
        "Our reading of the RFP highlights a need for a structured response that maps directly to client outcomes, delivery constraints, and assurance requirements.",
        `The current must-have themes include ${mustHaveText}.`,
        "We would treat these requirements as the baseline for solution design, delivery planning, and proposal compliance tracking."
      ].join("\n\n");
    case "proposed solution":
      return [
        "We propose a phased engagement model covering discovery, implementation, review, and handover.",
        "This allows the team to align scope, validate assumptions early, and evidence progress against the requirement checklist over the life of the response.",
        emphasisSentence ||
          "The solution narrative can be expanded with architecture, tooling, and delivery detail once stakeholders confirm the preferred approach."
      ]
        .filter(Boolean)
        .join("\n\n");
    case "delivery plan":
      return [
        "Delivery would be structured around clear milestones, named workstreams, and regular stakeholder checkpoints.",
        "This gives the client visibility into progress, dependencies, decisions, and risks while supporting iterative refinement of the proposal pack.",
        "Any timeline or commercial commitment would remain subject to confirmed scope and contract agreement."
      ].join("\n\n");
    case "team and relevant experience":
      return [
        "The proposed team would combine proposal leadership, delivery oversight, domain expertise, and quality review.",
        "Relevant experience should be framed in anonymized or approved-reference terms unless the client has explicitly requested named references.",
        "This section can later be expanded with bios, role splits, and approved case studies."
      ].join("\n\n");
    case "data privacy and security":
      return [
        "Data handling and security controls would be designed to reflect the sensitivity of the opportunity and the client's operating environment.",
        "We would document access controls, data minimization, review points, and compliance responsibilities as part of the delivery approach.",
        "Any security statements in the final proposal should align to evidence and approved commitments rather than broad guarantees."
      ].join("\n\n");
    case "commercials and assumptions":
      return [
        "Commercial detail should be positioned as indicative unless scope, dependencies, and contracting assumptions have been confirmed.",
        "This section is best used to state pricing approach, assumptions, exclusions, and commercial dependencies at an appropriate level of confidence.",
        "No fixed price or contractual commitment should be included until the team has approved it."
      ].join("\n\n");
    default:
      return [
        `This ${sectionName} draft is aligned to the current RFP understanding and the emerging proposal structure.`,
        `It should continue to reference ${mustHaveText} so the response remains traceable to the client's stated priorities.`,
        emphasisSentence ||
          "The wording is intentionally review-friendly and can be tightened once subject-matter input is available."
      ]
        .filter(Boolean)
        .join("\n\n");
  }
}

function reviseDraftSection(prompt: string): string {
  const instruction = extractTag(prompt, "instruction") ?? "";
  const currentContent = extractTag(prompt, "current_content") ?? "";
  const lowered = instruction.toLowerCase();

  if (lowered.includes("shorter")) {
    const paragraphs = currentContent.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    return paragraphs.slice(0, 2).join("\n\n") || currentContent;
  }

  if (lowered.includes("bullet")) {
    return splitSentences(currentContent)
      .slice(0, 5)
      .map((sentence) => `- ${sentence.replace(/\.$/, "")}`)
      .join("\n");
  }

  if (lowered.includes("emphasis")) {
    return `This revision places additional emphasis on ${instruction.replace(/^.*?on\s+/i, "").trim()}.\n\n${currentContent}`;
  }

  return `${currentContent}\n\nRevision applied: ${instruction}`;
}

function parseRequirements(rawJson: string | undefined): RequirementStub[] {
  if (!rawJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawJson) as RequirementStub[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractTag(source: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, "i");
  const match = source.match(pattern);
  return match?.[1]?.trim();
}

function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+/g);

  if (matches && matches.length > 0) {
    return matches.map((sentence) => sentence.trim());
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function toSnakeCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}
