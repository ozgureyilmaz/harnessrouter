# HarnessRouter vs direct Codex comparison

## Question

For the same public-page-to-hero-image request, what changes when this Codex chat delegates through harnessrouter instead of using its direct in-app browser and direct fal path?

This is a paired pilot, not a statistical performance claim. Both conditions stay in this Codex chat; no other agent orchestrates the control run.

## Conditions

**Routed:** current Codex calls `route_task` for the public page, then calls it again for a hero image using the returned `websiteObservations` and `parentRunId`. Decisions selects only eligible routes; Pi and fal-creative run as separate harnesses.

**Direct:** the same Codex chat opens the same public URL in its isolated Codex in-app browser, records the same acceptance fields, then submits the matched image prompt directly to fal with no Decisions call or harnessrouter planner. Do not use the normal Chrome profile.

## Controls

- Same URL, viewport, task objective, aspect ratio, quality profile, fal model, seed, dimensions, safety checker and output format. Full-workflow prompts may differ because each path prepares its own brief; the exact-input control freezes the routed model input and verifies its fingerprint before direct submission.
- A matched image pair reuses one frozen visual-observation JSON object in both conditions. A separate end-to-end pair may let each browser condition produce its own observations; label this as a full-workflow result because the evidence then differs.
- Alternate which condition runs first across repeated pairs when practical. Use fresh task IDs and fal requests for every new trial.
- Show the image artifacts without route labels and ask for blind 1–5 ratings on style match, composition, brief adherence and legibility. Keep this score separate from technical validity.

## Record per trial

Capture: condition, task/run IDs, exact model/profile and input fingerprint, verified screenshot/image metadata, decision latency, browser time, fal queue/generation/download time, total wall time, published-price estimate, provider invoice if available, Pi/Codex accounting status, retries/cancellations, acceptance checklist and blind image scores.

Report paired differences, completion/verification rate and all failures. With one or two pairs, show the raw rows and avoid population claims. Confidence/probability returned by Decisions is not success likelihood.

## Current readiness

- Native MCP is available in this reopened Codex chat and returns completed HarnessResults.
- The user selected `https://www.agentation.com/`. Live browser and image trials completed; results are in `paired-agentation-comparison.md` and `.json`.
- Routed browser used a fresh stdio MCP process with the exact hostname temporarily configured; the original `example.com` allowlist was restored. Routed image used native harnessrouter MCP in this chat. Direct browser used Codex CUA/in-app browser; direct generation used a thin official fal SDK call with shared budget and verification instrumentation.
- The approved total cap remains $5. Current experiment reports contain measured ledger snapshots; Codex and Pi OAuth per-request USD costs remain unknown.
- One preliminary visit occurred before an interrupted turn. It is excluded from measured trial rows; browser cache equivalence/fresh-context parity was not established.
