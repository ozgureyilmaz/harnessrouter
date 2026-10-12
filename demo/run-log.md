# Actual run log — 2026-10-12

## Final P0 verification — 2026-10-12

P0 is complete against the recorded verified revision. The user confirmed concurrent edits in another chat and requested preserving those changes. Native and final-local fingerprints are stored separately; later changes are outside this validation claim. Typecheck/build pass; 92 offline/mocked/local tests pass and 2 live integration tests skip. The 24-case evaluator passes 48/48 eligibility checks without provider calls. Native MCP schema 1.2 was proven with fresh browser run c32e2814-8908-4760-8b42-8bb477fad560 and image run a99494de-75e5-49c3-9e64-6a191728cc14. All seven mechanical criteria passed; visual similarity remained unverified. The two native route_task responses and get_run read-back matched persisted results, including usage and costComponents. The parent/observation context and canonical observation/input hashes were independently checked.

Browser: 4,525 input + 230 output tokens (Pi provider reported), no Decisions call because only one eligible route remained, Pi USD unknown. Image: 300 Decisions input tokens, FLUX.2 request 01a12fd8-3b28-74a3-b7a5-7f524a4d2914, decoded 1024x576 PNG; rate estimate $0.01203 including Decisions. Latest ledger remainder $4.768/$5; total provider invoice and host Codex usage unmeasured. Earlier stale-process failures remain historical evidence in demo/native-mcp-verification.json. No staging, commits, or pushes occurred.

The current Codex chat built the MVP and received real provider results. Native tool-catalog reload remains the final client integration check; the user elected to reopen the same chat after packaging.

| Proof | Route/model | Actual evidence | Measured duration |
|---|---|---|---:|
| Decisions smoke | gpt-6-luna → pi-browser:configured | 85b81bc7-f0c1-45b4-b505-4353e2256365 / decision-smoke.json | 2,526.04 ms |
| Direct creative fast | fal-ai/flux/schnell | 67a888e5-154a-4c08-830c-39b1971251a4 / fal-image.png; request 01a12f3c-131d-7391-8bf9-078c1846bc74 | 7,137.93 ms |
| Direct Pi | openai-codex/gpt-5.5 | c23c7420-3641-4bb6-999d-90f28e4d1214 / actual screenshot | 13,910.07 ms |
| Direct creative quality | fal-ai/flux-2 | 3b916f16-65aa-4d2b-9581-8cda60b5f326 / fal-image.png; request 01a12f49-ea5f-7512-a008-17f6bc931a4a | 7,900.94 ms |
| MCP browser, final hardened version | pi-browser:configured / openai-codex/gpt-5.5 | 9f372976-bce1-49a4-bdf4-cc1eb68136cf / result.json, decision.json, screenshot | 16,431.73 ms |
| MCP creative with browser carryover | fal-creative:image-quality / fal-ai/flux-2 | d73bceb2-70fa-4693-86a8-02e3150bb667 / result.json, decision.json, fal-image.png; request 01a12f4a-a0e1-7451-80a7-959a62f859be | 11,003.57 ms |
| Matched direct fal baseline | fal-ai/flux-2 | bf16042b-1cf6-43c0-94cd-bbfd29b62944 / baseline.json, baseline.png; request 01a12f4b-df99-75c1-99ad-f247c1c54ef9 | 17,272.63 ms |

All artifact paths are relative to the repository root under `artifacts/`. The two MCP calls were issued explicitly by this current chat through the real SDK/stdio bridge. No recursive Codex process, mocked provider result or synthetic artifact was used for these proofs.

## Composite continuity

- Browser measured background `rgb(238, 238, 238)`, black body text, blue link, system font and a 480px content column.
- Creative `parentRunId`: `9f372976-bce1-49a4-bdf4-cc1eb68136cf`.
- Creative observation hash: `7fcb28758aabe9fa32bc82f920f1eddf4f2c8cc8e5279b2401abb56a04a08382`.
- Independent final audit proved the stored source context is identical and reproduced both canonical observation and submitted-input hashes. `demo/provenance-audit.json` contains the reconstructed optimized input; it is explicitly an offline audit of the genuine run, with zero new provider calls.
- Final image: independently decoded PNG, 1024×576, seed 42. Local screenshot path was not uploaded to fal; bounded measured style entered the optimized prompt.
- Combined router processing: 27,435.30 ms. First router-request timestamp to final result: 129,911 ms, including host preparation and the separate quality smoke between calls. It is not claimed as user-message-to-answer latency.

## Failures and limitations

Two initial Decisions calls returned HTTP 400 because singleton choices are unsupported. The first diagnostic omitted status; bounded scalar error tracing was added, the second exposed the minimum-two contract. The corrected smoke succeeded. Those two ambiguous accounting records retain $0.02 in commitments rather than assuming a refund/zero invoice.

The audited pi-browser-use package exposed persistent profiles, arbitrary page evaluation and broad writes. It was not installed. A restricted first-party extension was used. An earlier direct Pi smoke preceded final hardening; the later MCP browser run proves the final implementation.

The real MCP protocol test returned all four tools and a valid rejection for a private-bank task, with no paid call. Native tool discovery in the original active Codex turn did not refresh; automatic UI control of Codex was denied by the UI tool. The registered project configuration is confirmed by `codex mcp get harnessrouter`.

## Measured accounting

Six live execution attempts completed with verified artifacts (two Pi, three creative, one direct baseline), and one additional Pi execution was cancelled. Twelve valid Decisions selections and two failed singleton-choice requests are recorded. The fixture evaluation matched 8/8 live choice labels; two native and two unsupported cases were handled by deterministic policy. These small counts are demonstration evidence, not benchmark claims.

Published-rate fees estimate: **$0.0393057**. Budget commitments: **$0.179**. Approved cap: **$5**. Actual invoices, failed-request charges and Pi OAuth per-request USD cost are unknown. `executionMs` includes child handoff/internal verification; do not double-count `handoffMs` when interpreting totals.

After reopening this chat, native `list_harnesses`, `get_run`, and both `route_task` calls succeeded. The route_task calls reused existing task IDs and returned cached verified results without new provider submissions. See `native-mcp-verification.json`.

The matched direct/specialist experiment used the same endpoint, seed, image dimensions, steps and generation constraints. Prompt specialization differs. Both images decode; quality was not graded, and sequential queues are a confounder. No speed/cost/quality benefit is claimed.

## P0 follow-up

Task capability filtering, deterministic single-route dispatch, paid Decisions admission, and criterion-level result schema 1.1 are implemented. Offline checks passed: typecheck, 69 tests passed with 2 opt-in live tests skipped, build, nonbillable precheck, and local stdio MCP protocol smoke. The local ledger reports $4.806 remaining on the existing $5 session cap. No new provider execution occurred in this follow-up.

The active Codex harnessrouter tool catalog still advertises result schema 1.0 and lacks the optional requiredCapabilities input. It also reported $4.821 remaining while the local budget ledger reports $4.806. Fresh native execution against the updated contract is pending catalog/server reload and budget-view reconciliation. The existing native route_task records above are cached replays, not new provider runs.

## Earlier P0 attempt — stale process (historical)

Local checks on the current source passed: typecheck, build, 86 tests passed, 2 opt-in live tests skipped, non-billable evaluation 48/48 eligibility steps, and local MCP protocol smoke. The two integration skips did not start Pi or fal provider work.

| Fresh native task | Route/model | Result and evidence |
|---|---|---|
| `p0-browser-20261012-4uwxdm2x` | `pi-browser:configured` / `openai-codex/gpt-5.5` | Run `6f38d329-8b9a-4e1d-b064-f48f72cbec93`; four criteria passed; verified 1280×720 PNG. Decision was `not_required` because only one specialist route was eligible. Pi USD cost is unknown. |
| `p0-image-20261012-8r5h86ax` | `fal-creative:image-fast` / `fal-ai/flux/schnell` | Run `5117c78e-14d3-4388-9b4b-f5b804bb97c4`; parent is the browser run; verified 1024×576 PNG; fal request `01a12fc2-03f3-79f3-8360-1f4e21c9e608`; rate estimate including Decisions `$0.0030315`, not an invoice. |

The active long-lived native server returned result schema 1.1. Its fal criterion verifier produced two false negatives; the current source verifier reevaluated the saved evidence and all three criteria passed. Current code builds result schema 1.2 with per-provider usage/cost components, and local tests/smoke pass, but those fields were absent from the live native response. Reload the MCP process and call `get_run` for both IDs to close the current-contract read-back gate; do not submit another image just for refresh. Remaining session cap at the latest native health read: `$4.79` of `$5`.
