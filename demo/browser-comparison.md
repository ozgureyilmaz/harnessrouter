# Browser workflow comparison — 12 October 2026

Full shared browser task: open example.com in a fresh isolated browser, return title/final URL and the documentation notice with exact link label/target, measure CSS/layout, capture and verify a 1280×720 screenshot. No image generation is part of this task.

| Metric | Native Codex browser | Codex → MCP → Pi |
|---|---|---|
| Task checks | 4/4 passed | 3/4 passed; exact href missing |
| Captured processing | 0.784 s browser tool block | 14.365 s MCP server total |
| Input / output / total tokens | unavailable | 4883 / 330 / 5213 |
| USD cost | unknown | unknown |
| Actual model identity | not reported by CUA | openai-codex/gpt-5.5 |
| Artifact | decoded 1280×720 JPEG | decoded 1280×720 PNG |

These times do not establish a speed advantage: native tool timing excludes outer model thinking; Pi total includes internal agent thinking. Prompt-to-answer time and complete per-arm model costs were not measured. The Pi HarnessResult runtime is completed, but the complete user task is partial because exact link-target extraction failed. No Decisions request was needed for the sole eligible specialist route.

The native first link was Learn more → https://iana.org/help/example-domains. Pi described the target as uncertain rather than returning the observed href. The evaluator records this failure and does not replace it with the native observation.

Saved data: demo/browser-comparison.json. Source evidence: artifacts/browser-pilot-20261012/native-result.json and the Pi run 3e98edca-9682-4abf-8b46-c3d0369ff52b. Screenshots copied byte-for-byte into demo/preview/assets/browser-pilot for portable display.

The previous Pi→creative demo, Codex-only image-task placeholder and creative-only baselines remain separate.

## Metering resolved from current-session logs

The original capture above had missing host counters. A later read-only projection of the exact executor-response records resolved the active host model as **gpt-6.1-sol / high**. Raw session messages, prompts and private paths were not copied into the public dataset.

| Metric | Native executor response | Host executor response + Pi |
|---|---:|---:|
| Recorded tokens | 188,108 | 194,648 |
| Cached input (included in total) | 185,856 | 187,136 |
| Observed response + tool window proxy | 24.365 s | 40.105 s |
| Standard API-rate equivalent | $0.0297616 | $0.0632586 |

Native token breakdown: 187,274 input (185,856 cached), 834 output. Routed host: 188,731 input (187,136 cached), 704 output; Pi: 4,883 input, 330 output. Reasoning tokens are already included in output and are not added again. The routed estimate comprises $0.0289436 host + $0.034315 Pi.

These response windows start at the prior tool output and end at the executor tool output. They include host generation/dispatch and executor processing but exclude earlier plan/setup and later review/UI work. The native browser tool itself still measured 0.784 s, and Pi MCP processing still measured 14.365 s. Complete task token usage and prompt-to-answer latency remain unmeasured.

Rates: [official OpenAI API pricing](https://developers.openai.com/api/docs/pricing), Standard, <=272K input. GPT-6.1 Sol input/cached/output = $2/$0.10/$10 per million; GPT-5.5 = $5/$0.50/$30. Actual subscription/OAuth USD billing, speed tier and regional processing were not observed; these are explicit reference estimates, not invoices or comparative-advantage proof.
