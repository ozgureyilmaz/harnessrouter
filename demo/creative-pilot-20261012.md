# harnessrouter creative-only pilot — 12 October 2026

## Finding

Six actual images were generated in three matched pairs and passed technical artifact checks. This pilot found no consistent speed advantage, no estimated generation-fee saving, and no quality advantage in the illustrative assistant review. It is not a complete Codex-only comparison.

## Method

Compared native Codex MCP → harnessrouter → fal-creative against a direct fal queue call using plain serialized CSS context. The source observations, base objective, FLUX.2 model, seed 42 and all non-prompt parameters were held constant. Prompt construction/context projection was the intervention. Three pairs ran sequentially in R-D, D-R, R-D order.

After execution, deterministic plan recomputation matched the routed input fingerprints, and all three direct/routed non-prompt parameter objects matched. All source observation hashes matched. Prompt expansion was enabled in both arms; a fixed seed does not guarantee identical repeated outputs.

The direct baseline reuses the existing planner only to fix identical generation parameters. It is a plain direct API baseline, not an optimized Codex-written creative prompt or a native Codex image-generator comparison.

## Captured results

| Pair | First arm | Direct fal seconds | MCP + fal-creative seconds | Faster captured run |
|---|---|---:|---:|---|
| 1 | routed | 14.55 | 29.48 | direct |
| 2 | direct | 8.55 | 11.77 | direct |
| 3 | routed | 23.07 | 12.01 | routed |

Mean: direct **15.39 s**, routed **17.75 s**. Median: direct **14.55 s**, routed **12.01 s**. Means and medians rank the paths differently; do not select one statistic to claim superiority.

Both arms produced **3/3 technically valid images**. This is not aesthetic quality or calibrated reliability.

Timing measures image-job processing through a verified downloaded image. Browser observation, host reasoning and model token costs are excluded; direct process/config/planning startup is excluded. Download/network variability is included. Inner/outer verification timers have different boundaries and must not be directly compared.

## Cost

Published-rate estimates: **$0.012 per image in both arms; $0.072 total for this six-image pilot**. Actual invoices were not returned. High-quality requirements left only one specialist route, so selection was deterministic and no paid Decisions calls occurred. This experiment cannot measure the value or overhead of Decisions selection, or total Codex/Pi workflow cost.

## Illustrative quality assessment

A/B identities were hidden during assistant visual inspection. Brief: light neutral background, centered minimal open book, restrained blue accent, generous whitespace, no lettering or logos.

| Anonymous image | Brief adherence /5 | Style adherence /5 | Composition /5 |
|---|---:|---:|---:|
| A | 4 | 4 | 4 |
| B | 4 | 4 | 4 |

A is more centered and symmetrical; B has a stronger diagonal perspective. Both use multiple blue elements rather than one small accent. This was an illustrative assistant assessment, **not human ratings or an independent quality benchmark**; preference was a tie. Only pair 1 was reviewed.

## Safe pitch sentence

> We ran three live matched creative-only pairs with the same model, seed and generation parameters. Both paths produced three valid artifacts. Speed varied and generation-price estimates were equal; we have not established speed, cost or quality superiority. The demonstrated capability is cross-harness interoperability with verifiable outputs.

## Evidence

Pre-registered plan, complete per-run controls and blind assessment are saved locally in `artifacts/creative-pilot-20261012/`. Provider request IDs and actual files remain in the original run directories. No runtime feature was changed for this pilot.

- Pair 1: routed `dc4a79bc-0554-41ce-acdd-486150d31a72`; direct `3c72fe71-2c58-46df-86e4-75ee4292842e`.
- Pair 2: routed `a4ce6dfb-37b4-4c95-bffe-8a59c0c549c2`; direct `1542882d-1fde-40ab-915b-efcda8be8786`.
- Pair 3: routed `69129498-15b0-43ad-a23f-a9f64e747791`; direct `fe2489d5-3653-42dc-b5fc-5bfde8c60420`.

The report contains aggregate findings and run IDs only. Ignored artifact directories, private runtime state and credentials are excluded from public source delivery.
