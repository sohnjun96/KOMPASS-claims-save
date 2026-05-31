---
name: k-larc-rag-ops
description: Stabilize and improve K-LARC RAG quality for Deep/Quick analysis. Use when editing step prompts, grounding validation, deterministic merge logic, or step-level LLM parameter profiles in modules/k-larc.
---

# K-LARC RAG Ops

## Scope
- Treat stability as first priority: reduce output variance before chasing recall.
- Keep each step single-purpose and contract-driven.
- Prefer deterministic post-processing for merge/normalization/dedup.

## Workflow
1. Confirm step contract boundaries.
- A: feature decomposition only.
- B-1: query generation only.
- B-2: evidence extraction plus local grounding validation.
- B-3: deterministic merge only.
- C: status/evidence decision only.
- D: targeted repair plus same grounding gate as B-2.
- E: audit/warning only.

2. Enforce I/O contract checks in code.
- Normalize IDs (`F#`, `D#`) early.
- Validate required fields (`Feature`, `MatchType`, `Content`, `SourceExcerpt`, `Position`) before downstream use.
- Drop or repair invalid items; never pass-through unknown structure.

3. Keep prompt budget small.
- Remove duplicate instruction blocks.
- Keep one hard objective per prompt.
- Use explicit allowed output schema and reject extra keys.

4. Apply conservative decoding for judge/verification steps.
- Use lower temperature for B-2, B-2 repair, C, E.
- Keep generation diversity mostly in B-1 and D query generation.

5. Verify with regressions.
- Run smoke tests.
- Run at least one Deep plus one Quick scenario and inspect:
  - parse success rate
  - invalid grounding count
  - repair hit rate
  - final warning/caution rate

## Editing Rules
- If a step output feeds another LLM step, keep trace fields needed for later judgment (for example `SourceExcerpt`) until that step is done.
- Do not reintroduce LLM merge if deterministic merge already covers the requirement.
- When adding prompt rules, add matching code-level guardrails in the parser/validator.

## Done Criteria
- No schema parse failures in nominal flow.
- D-step outputs pass the same grounding validator as B-2 outputs.
- B-3 produces stable merged output with deterministic logic.
- Smoke checks pass.
