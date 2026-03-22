# Researcher Report

## Scope

This pass focused on logic and algorithm files only. I did not touch UI/UX, visual styling, or deployment infrastructure.

Reviewed implementation areas:

- `openclaw/runtime/proposal-operator.ts`
- `backend/proposal-api.ts`
- `openclaw/skills/proposal-operator/parse_rfp.ts`
- `openclaw/skills/proposal-operator/plan_proposal_structure.ts`
- `openclaw/skills/proposal-operator/draft_section.ts`
- `openclaw/skills/proposal-operator/revise_section.ts`
- `openclaw/skills/proposal-operator/export_proposal.ts`
- `openclaw/skills/proposal-operator/update_checklist_coverage.ts`
- `openclaw/skills/proposal-operator/workspace_status.ts`
- `openclaw/skills/proposal-operator/shared.ts`

## Current Algorithms And Data Structures

1. RFP parsing and structure planning are model-driven extraction/generation steps with JSON schema coercion.
2. Requirement coverage is a heuristic lexical matcher:
   - normalize text into keywords
   - canonicalize synonyms/stems
   - split section text into chunks
   - score chunk overlap using token, phrase, and concept recall
   - emit evidence when a chunk clears a fixed threshold
3. Proposal export is deterministic section assembly with a final guardrail pass.
4. Workspace/API state is stored as file-backed JSON plus markdown artifacts inside per-workspace folders.

The most important algorithmic bottleneck was the coverage refresh path. Before this pass, every requirement re-tokenized and re-chunked every section, so the same section work was repeated `requirements x sections` times.

## Implemented Quick Win

### Rationale

The current matcher is still a reasonable first-pass lexical evidence system for a proposal workstation:

- it is explainable
- it is deterministic
- it is cheap to test
- it preserves visible evidence links for operators

The problem was not the scoring idea first. The problem was repeated feature extraction. That makes `update_checklist_coverage` do avoidable work every time it recomputes requirement coverage across the workspace.

This was the best low-risk optimization because it:

- does not change product behavior intentionally
- keeps the current evidence model intact
- improves the hottest repeated path immediately
- creates a clean seam for later retrieval upgrades

### What Changed

- Added `prepareCoverageSections(...)` in `openclaw/skills/proposal-operator/shared.ts` to precompute chunk-level lexical features once per section.
- Added `findRequirementEvidenceInPreparedSections(...)` so requirement matching can reuse the prepared section index.
- Updated `update_checklist_coverage.ts` to prepare section features once, then reuse them across all requirements.
- Added token canonicalization caching in `shared.ts` so repeated stemming/alias normalization does not redo the same work.
- Replaced `proposalExists` full-file reads in `workspace_status.ts` with a `stat`-based existence check via `pathExists(...)`.
- Added regression coverage in `openclaw/tests/coverage-matcher.test.ts`.

## Benchmark

### Coverage Matcher Before/After

Workload:

- 180 requirements
- 12 sections
- 6 paragraphs per section

Measured locally with the pre-existing matcher path versus the new prepared-section path:

```json
{
  "baselineMs": 114.67,
  "optimizedPrepMs": 0.6,
  "optimizedMatchMs": 7.95,
  "optimizedTotalMs": 8.54,
  "speedup": 13.43
}
```

Interpretation: the optimization removes repeated chunking/tokenization from the inner loop and cuts total matching time by about `13.4x` on a representative workload.

### Workspace Status Existence Check

Measured against a generated `proposal.md` of about `4.32 MB`:

```json
{
  "proposalBytes": 4320012,
  "readMs": 1.99,
  "statMs": 0.09,
  "speedup": 22.77
}
```

Interpretation: when the UI only needs a boolean `proposalExists`, reading the full proposal body is unnecessary overhead.

## Findings

### Quick Wins

1. Precompute lexical section features once per coverage refresh.
   - Implemented in this pass.
   - Lowest risk and highest immediate runtime payoff.

2. Use metadata checks instead of content reads for boolean status signals.
   - Also implemented in this pass for `proposalExists`.
   - Helpful for larger proposals and high-frequency polling.

3. Hoist repeated normalization/extraction work behind stable helper seams.
   - Partially implemented via canonical token caching.
   - Further small wins remain in operator response assembly, but they are secondary to the matcher hotspot.

### Medium Efforts

1. Replace the ad hoc lexical matcher with a small inverted index plus BM25/BM25F-style ranking over proposal chunks.
   - Why: the current thresholded overlap scorer is explainable, but it is still heuristic and brittle for long, paraphrased requirements.
   - Benefit: better recall/precision tradeoff, principled term weighting, and natural support for section-title/body field weighting.
   - Mapping: requirement text becomes the query; proposal chunks become documents; section titles can become a boosted field.

2. Add a persistent workspace-local retrieval cache.
   - Why: sections are read and reinterpreted repeatedly across coverage, export, and status flows.
   - Benefit: faster repeated operator actions and a clean substrate for future semantic retrieval.

3. Introduce offline evaluation sets for requirement-to-evidence matching.
   - Why: right now the matcher is tested with regressions, but not benchmarked as a retrieval problem with precision/recall style metrics.
   - Benefit: safer future upgrades and measurable algorithm selection.

### Research Bets

1. Hybrid lexical plus sparse neural retrieval for coverage evidence.
   - Candidate direction: SPLADE-style sparse retrieval.
   - Why: keeps inverted-index efficiency while recovering paraphrases better than simple keyword overlap.

2. Late-interaction retrieval for high-value proposal evidence search.
   - Candidate direction: ColBERT-style passage retrieval.
   - Why: better semantic matching for long requirements and section evidence, but with higher serving/storage cost.

3. Build a BEIR-style held-out evaluation harness for proposal requirements.
   - Why: retrieval quality should be judged on out-of-distribution requirement phrasing, not only happy-path prompts.
   - Benefit: gives a benchmark framework for deciding whether BM25, sparse retrieval, or late-interaction is worth the complexity.

## Evidence From Published Work

These are the main papers that informed the recommendations:

1. Robertson and Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond" (2009)
   - Relevance: supports the medium-effort recommendation to replace thresholded lexical overlap with a principled lexical ranking model such as BM25/BM25F.
   - Link: https://ir.webis.de/anthology/2009.ftir_journal-ir0anthology0volumeA3A4.0/

2. Thakur et al., "BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of Information Retrieval Models" (2021)
   - Relevance: useful evaluation model for deciding whether lexical, sparse, or late-interaction retrieval generalizes best to new requirement phrasing.
   - Link: https://arxiv.org/abs/2104.08663

3. Khattab and Zaharia, "ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT" (2020)
   - Relevance: supports the research-bet path for semantically richer requirement-to-section retrieval with offline document encoding and faster query-time interaction than full cross-encoding.
   - Link: https://arxiv.org/abs/2004.12832

4. Formal et al., "SPLADE v2: Sparse Lexical and Expansion Model for Information Retrieval" (2021)
   - Relevance: supports the research-bet path for hybrid efficiency plus semantic expansion while retaining inverted-index-friendly sparse retrieval.
   - Link: https://arxiv.org/abs/2109.10086

## Validation

- `npm run typecheck`: passed
- `npm test`: passed, `26/26`

## Conclusion

The current architecture is still sensible for a guarded proposal workstation, but the coverage matcher was doing repeated work that scaled poorly as requirements and sections grew. Precomputing section features was the right first intervention: it keeps behavior stable, improves runtime materially, and leaves the codebase in a better position for a future BM25 or hybrid retrieval upgrade.
