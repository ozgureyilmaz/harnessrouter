# harnessrouter: current status, vision fit, and master plan

**Updated:** 2026-10-12. **P0: complete against the verified revision.** The user confirmed another chat is changing the same checkout and directed that its edits be preserved. Fresh native execution and metering are bound to the recorded live-source fingerprint; the final local checkpoint is bound to its separate 92-test fingerprint. No validation claim applies to later concurrent changes. P1 controlled comparisons remain open.

## Product assessment

The implementation follows the repository's hackathon product thesis: the current Codex session delegates one task at a time through local MCP to an independent Pi browser runtime or the purpose-built fal-creative harness. It filters authorized/reachable/capable routes before selection and returns inspectable results, artifacts, criteria, usage, cost components, and traces. Codex owns composition through two explicit calls.

The supported claim is **cross-harness interoperability**. Improvement in task success, speed, cost, or image quality is unproven. The broader agent-harness platform remains separate scope; this local routing gateway can be a replaceable component within it.

The pasted “build before / 0 of 9 complete” plan is historical. Most foundations are implemented; local Decima/Ollama and a three-strategy controlled benchmark remain future work.

## Completed P0 evidence

| Item | Status | Evidence / limit |
|---|---|---|
| Current typecheck/build | PASS | Both completed successfully at the final recorded local checkpoint; later concurrent edits remain separate. |
| Default test suite | PASS | 92 passed, 2 opt-in live integration tests skipped, 0 failed. Offline tests include provider doubles, real local artifact decode, and fake RPC streams. Skips did not trigger Pi/fal work. |
| Offline harness evaluator | PASS | 24 cases, 48/48 eligibility checks, no provider or Decisions calls. Eligibility is not execution success. |
| Non-billable readiness and MCP smoke | PASS | Pi/fal credentials and health checked; four stdio tools exercised and prohibited task rejected without provider spend. |
| Native schema 1.2 execution | PASS | Two new task IDs and run IDs; top-level usage and costComponents returned through native MCP. |
| Native persistence/read-back | PASS | Native route_task responses match saved result.json and subsequent native get_run, including usage/costComponents and criterionResults. |
| Composition provenance | PASS | Second task parentRunId and observations exactly match first output; current planner reproduces canonical observation and submitted-input fingerprints. |
| Supported criteria | PASS | Browser 4/4 mechanical criteria; image 3/3 mechanical criteria. Visual similarity remains explicitly unverified. |
| Artifact verification | PASS | Actual 1280x720 screenshot and 1024x576 PNG decode; hashes and provider request ID recorded. |
| Documentation consistency | UPDATED | START_HERE/RUNBOOK now describe post-build work; original CODEX_BUILD_PROMPT marked historical. Plan, gates, sources, demo, and status align with native result 1.2 and unknown-cost limits. |
| Source delivery | REVIEWED | Exact allowlist/manifest and scan in docs/DELIVERY_REVIEW.json. Source remains untracked; nothing staged, committed, or pushed. Secrets, local state, build notes and presentation work excluded. |

## Fresh native runs

| Task | Run ID | Route | Result |
|---|---|---|---|
| Browser inspection | c32e2814-8908-4760-8b42-8bb477fad560 | pi-browser:configured / openai-codex/gpt-5.5 | Schema 1.2; navigation, title/URL, screenshot, palette/typography/layout passed. |
| Image from observations | a99494de-75e5-49c3-9e64-6a191728cc14 | fal-creative:image-quality / fal-ai/flux-2 | Schema 1.2; request ID, 16:9 artifact, and planner provenance passed; similarity unverified. |

Evidence: `demo/native-mcp-verification.json`, `finalP0Verification`. Artifacts are local under ignored `artifacts/<runId>/`. Both calls were issued by this current Codex chat; no nested Codex was launched to provide this evidence.

The browser had one eligible route and selected it deterministically, `decisionStatus: not_required`; it made no Decisions request. Pi reported 4,525 input and 230 output tokens. The image Decision reported 300 input tokens and selected FLUX.2. Rate-estimated image+Decision fees are $0.01203. Pi OAuth per-task USD, host Codex usage, and provider invoices are unknown; do not describe that fee subtotal as full workflow cost. Latest session ledger has $4.768 remaining of the approved $5 cap. Router processing sum was 26.535 seconds; host preparation and user-prompt-to-answer time are not included.

## Problems found and corrected

- An older long-lived native process returned schema 1.1 even though the tool catalog advertised 1.1/1.2. Its two fresh earlier runs are retained as history; the final fresh pair and read-back prove the current 1.2 handler.
- The image criterion evaluator looked for the fal request ID only in structuredOutput. It now accepts the actual provider ID attached to a verified image artifact.
- Planner-provenance verification used the wrong output shape. It now checks parentRunId, the observation fingerprint, source URL, and normalized observedFields. The audit separately proves hash equality and source-context continuity; aesthetically matching the page remains unverified.
- Unknown-cost details implied a Decisions fee even on single-route tasks. Current results distinguish no decision request from unpriced harness execution.
- The latest benchmark code had import/stdio typing issues and a provider-group fixture mismatch during checks. Current typecheck and tests pass; no live benchmark was launched.
- The delivery allowlist lacked scripts required by npm commands and the cached task examples. Those are now explicitly included; secrets, artifacts, and presentation output remain excluded.

## What remains partial by design

- Criterion evaluation supports a small set of mechanical checks; arbitrary prose/negative conditions and artistic quality remain unverified.
- Browser scope is public read-only navigation/extraction/screenshots. Form entry, account login, payments, downloads, and arbitrary JavaScript are unsupported. The old form-interaction fixture now resolves to no route.
- Pi has one configured execution profile. Creative fast/quality profiles are real distinct endpoint/parameter policies; their relative advantage has not been measured.
- Provider failure returns an explicit error/defer/no-route. A separate deterministic strategy can be added for comparison, but it must not silently execute a prohibited route or repeat an ambiguous paid request.
- The 24-case evaluator has direct and router paths. The benchmark capture/import/storage/report code exists, but repeated static-vs-Decisions experiments and local Decima remain open. A benchmark CLI that explicitly launches independent Codex trials is separate from the live same-session host workflow; it was not run during P0.

## P1: measure whether routing helps

1. Define a deterministic static selection arm alongside Decisions with the same eligibility set, executor, budgets, timeouts, task criteria, and recorded tie-breaks. Direct API versus harness measures specialization; static versus Decisions measures routing. Keep the two questions separate.
2. Run matched, repeated, order-balanced comparisons where more than one route is genuinely eligible. Record task/prompt hash, seed, parameters, route, execution/verification, queue conditions, usage, and cost source. Stop ambiguous paid work and reconcile before any retry.
3. Grade image outputs with the documented human rubric, preferably blind to the generating arm. Report sample size and limits. Do not infer quality from a valid MIME or dimensions.
4. Report success, failure, ungraded cases, latency, abstention/recovery, and partial known/estimated/unknown costs across all attempts. Do not add handoff time twice; it is already inside execution time. No comparative improvement claim until evidence supports it.
5. Review source delivery manifest before an explicitly requested commit or push. Keep local artifacts available for the demo without staging all generated output.

## P2: expand when justified

Add Decima/Ollama, another runtime, real alternative Pi profiles, video, marketplace, UI, or hosting only after a concrete need and measurement protocol exist. These are not P0 blockers.

Later working-tree metering refinements were validated locally (92 tests passed, 2 skipped) after the native proof. Another chat then continued editing. The user requested preserving that work and recording P0 against the verified revision. Separate live and final-local source fingerprints are stored in the evidence; later edits are listed in docs/DELIVERY_REVIEW.json and are not claimed to have passed P0 checks.

## Sources of truth

- Product boundary: `AGENTS.md` and `docs/PRODUCT_SPEC.md`.
- Current status/backlog: this document.
- Chronological evidence: `docs/BUILD_LOG.md`; historical entries remain historical.
- Current native proof: `demo/native-mcp-verification.json`, `finalP0Verification`.
- Operator workflow: `README.md`, `START_HERE.md`, `docs/RUNBOOK.md`.
- Contract: task v1.0; current result v1.2 with legacy v1.1 read compatibility.
- Delivery boundary: `docs/DELIVERY_ALLOWLIST.md` and `docs/DELIVERY_REVIEW.json`.
