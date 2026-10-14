# Harness performance pilot

The pilot runs the current Pi browser and fal-creative harnesses, then grades saved evidence with GPT-6 Luna at high reasoning. DeepEval 0.9.22 provides a custom BaseMetric; the grading request uses the project's OpenAI Responses SDK directly. The browser agent model and fal generator bindings are unchanged.

## Commands

```bash
npm run eval:pilot
npm run eval:pilot -- --mode live --max-cost-usd 4
npm run eval:pilot -- --mode regrade --evaluation-id <original-evaluation-UUID> --max-cost-usd 1
```

The first command checks all task contracts, fixture admission and eligible routes with zero provider/judge calls. Live mode requires the existing live-run authorization and credentials in ignored `.env`. Regrade reads saved outputs and calls only the semantic judge: it does not rerun Pi, fal or Decisions. Every invocation has a new evaluation ID, private `summary.json` and Turkish `report.md` under `artifacts/evaluations/<id>/`. Historical outputs remain intact.

## Cases and interpretation

`fixtures/pilot-suite.json` contains 6 direct Pi cases, 6 direct fal cases and 2 router composition cases. Three repetitions produce 42 workflow trials and 48 individual harness steps. Image seeds are 42, 43 and 44. Both configured fal profiles are tested at square, wide and tall aspect ratios.

Four Pi cases run a real RPC agent against host-owned static pages intercepted in the isolated browser. This controlled environment is labeled separately from the two public pages. Fixture HTML cannot be enabled or supplied through MCP task input: the evaluator passes it through a constructor-controlled child environment. Every other request is aborted in controlled mode. Public runs use an evaluation-scoped allowlist that includes example.com and IANA; the normal server's allowlist is not changed. An independent browser reference records source title/text/style, screenshot hash and capture time.

Mechanical evidence includes artifact decoding, actual dimensions, provider request ID, independently observed title/URL/style, and composition provenance. Semantic dimensions use a fixed 0–4 rubric and initially require every dimension to score at least 3. A judge failure/refusal is ungraded, never a fabricated zero. The two text control calls are transport/rubric sanity checks, not proof that scores agree with human ratings. Image human-review fields remain pending until a person inspects them.

Resolved task failures remain in the denominator and do not suppress later independent samples. Failed upstream composition steps skip their dependent generation. Cancellation, exhausted authorization and unresolved paid operations halt remaining samples, which remain visible as skipped. No provider or judge request is automatically retried.

## Cost and timing

The invocation cap includes all fal, Decisions and judge ledger reservations and cannot exceed $4. Scope IDs and caps persist in the shared session ledger; cap enforcement uses commitments, not only successful outputs' estimated cost. Each judge reserves at most $0.05, has 8,192 output tokens and a 60-second timeout. Estimated charges retain their reserved upper bound.

Completed Pi OAuth usage remains unpriced in USD and is shown in token records. It is not an unresolved paid API operation, so a confirmed completed Pi task can proceed to its composition step or another repetition. Unknown charges associated with reserved API operations stop the run.

The report groups results by harness, environment and route, shows failed/ungraded/skipped outcomes, median/p95 harness duration, usage and known/estimated cost subtotals. Judge time and cost are reported separately; neither is added to harness latency. Source/suite hashes, model IDs, reference timestamps, traces and artifact paths preserve provenance. These small synthetic samples describe the captured runs; they do not establish general reliability or comparative superiority.

## Dependencies and local reporting

DeepEval telemetry and dotenv loading are disabled before import; the runner invokes BaseMetric locally and never calls Confident Cloud reporting. No additional credential is needed. Published DeepEval 0.9.22 imports an undeclared Sentry module, so the evaluator supplies pinned `@sentry/node@11.7.0` as a development dependency. A scoped protobufjs 8.8.1 override removes the high/critical advisories in the new dependency tree. The installed evaluation development dependency tree retains 12 moderate advisories. The override removes its high and critical advisories; this is not a passing safety audit.
