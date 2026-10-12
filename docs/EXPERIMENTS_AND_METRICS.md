# Benchmark plan — what is being proved?

## Hypotheses (keep distinct)

- **H1 interoperability:** current Codex can delegate to separate Pi runtime and custom creative runtime and get usable results.
- **H2 selection correctness:** Decisions chooses valid task-compatible `(harness, model-profile)` routes among eligible options.
- **H3 specialization benefit:** a purpose-built creative harness can beat direct API use on specified task objectives (e.g. fewer invalid outputs or budget overruns); **unproven until benchmarked**.
- **H4 route benefit:** on tasks where ≥2 viable harness routes exist, learned/semantic selection can improve measured outcomes relative to fixed baseline; **not measurable from mere browser-vs-image separation**.

## Experimental comparisons

1. **Router classification:** 12 labeled fixture tasks (browser, creative, native, unsupported), run each with at least 3 paraphrases if time; score route family accuracy/abstentions and invalid-route rate. No claim about execution speed. B-04 now requires `browser.form_interaction`, which no current harness declares, and must resolve to no eligible route. The previously captured B-04 Pi label is historical and must not be counted as current policy behavior.
2. **Creative baseline:** for same prompt, same fal model, same seed if supported, same quality constraint/budget, compare `Codex → direct fal call` vs `Codex → fal-creative` for technical validity, total latency, direct cost, extra planning/verification latency. Use multiple runs if budget permits.
3. **Browser baseline:** if Codex has comparable browser environment, compare identical browser task/acceptance criteria to Pi route. If environments/models differ, clearly label confounders; not a pure harness comparison.
4. **Composite workflow:** acceptance checklist: URL observed, website style data persisted, final image generated using observed data, 2 traces correlated. Measures composability, not outperforming one-harness baseline.

## Metrics & formulas

- `verified_success_rate = successful_independently_verified_runs / attempted_runs`.
- `route_accuracy = correct_route_family_selections / labeled_evaluable_cases`.
- `invalid_choice_rate = invalid_decision_choices / total_decision_responses`.
- `latency_end_to_end_ms = request_received_to_final_result`; also record `decision_ms`, `handoff_ms`, `execution_ms`, `verification_ms` separately (avoid double counting).
- `cost_total_usd = decision_api_usd + agent_model_usd + fal_generation_usd + other_provider_usd` when measured; else provide partial known components + unknown flags.
- `quality` requires a documented human rubric (brief adherence, legibility, composition, similarity to reference) or independent grader, blinded when possible. A valid image MIME is **not** evidence of high aesthetic quality.
- Route decision confidence is model metadata, **not** real-world calibrated accuracy.

## Example report table (blank template; not measurements)

| Task ID | Route | Verified? | Decision ms | Execution ms | Total ms | Cost USD | Evidence |
|---|---|---:|---:|---:|---:|---:|---|
| B-01 | TBD | pending | — | — | — | unknown | — |
| C-01 | TBD | pending | — | — | — | unknown | — |
| MIX-01 | TBD | pending | — | — | — | unknown | — |

## Avoid misleading claims

- A semantic classifier identifying browser vs image is not proof of adaptive efficiency.
- More complex agent harnesses may be slower/costlier than calling fal directly; report the negative result if so.
- An agent's self-reported `success=true` is not verification.
- The HM-Router paper is **external motivation**, not independent validation of this implementation.

## Operational reliability evaluation

The 24-case synthetic operational set is stored in `fixtures/harness-evaluation-tasks.json`: 6 browser, 6 image, 4 host-defer, 4 unsupported and 4 composed cases. Browser, image and composed cases have direct-harness and router paths; host-defer and unsupported cases are router-only because there is no standalone specialist execution to measure for those outcomes.

Run `npm run eval:harnesses` for schema and deterministic eligibility checks. It makes zero provider and Decisions calls; it does not execute any agent. For live execution, select one case and one path explicitly:

```bash
npm run eval:harnesses -- --mode live --case C-01 --path direct --max-cost-usd 0.25
npm run eval:harnesses -- --mode live --case C-01 --path router --max-cost-usd 0.25
```

The requested cap applies to the whole evaluator invocation, including repetitions and every step in a composed case. Live execution also requires the normal paid-run authorization and enough remaining session budget. Repeats default to one and run sequentially. Failures and unresolved operations stop the run. A completed step with unpriced Pi OAuth usage can pass observations to the next composition step, but its cost remains unknown and no further repetition is started. No ambiguous execution is resubmitted.

The dollar cap bounds priced/estimated reservations recorded in the shared ledger. Pi OAuth usage has no USD amount in this integration, so that component remains `unknown`; the evaluator reports this rather than treating it as free or claiming the USD cap covers it.

Reports are unique by evaluation UUID under `artifacts/evaluations/`; each step also points to its own run trace and artifacts. The report separates verified task success, failed and unverified checks, `HarnessResult.criterionResults`, latency, and known/estimated/unknown cost. Image outputs have a separate pending 1–5 human review field with brief adherence, legibility, composition and visual coherence prompts. Human review is not part of mechanical success. Offline eligibility checks and the older `eval:live` classifier do not establish live execution reliability.

This set supports an initial operational map of where the current configured harnesses work. It is synthetic and small, so it does not establish a calibrated success probability or any comparative advantage. Add sanitized real cases as observed; preserve the expected behavior and verification method before running them.
