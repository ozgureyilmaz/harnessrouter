# Local run metering

This feature collects local measurements. It does not establish an efficiency improvement until matched real tasks have been executed and graded. The preview UI is outside this implementation.

## Capture a Codex CLI run

Use a case JSON with `caseId` and `prompt`. Each explicit invocation starts a fresh `codex exec --json --ephemeral` session. Both arms use the same case and model; the direct arm disables the configured HarnessRouter MCP server, and the integrated arm enables and requires it. Set equal tool access, reasoning effort, permissions and starting files before comparing.

```bash
npm run build
npm run benchmark -- run --case fixtures/benchmark-case.example.json --arm codex_direct --model gpt-6.1-sol --reasoning-effort high --repetitions 1
npm run benchmark -- run --case fixtures/benchmark-case.example.json --arm codex_harnessrouter --model gpt-6.1-sol --reasoning-effort high --repetitions 1
```

These commands launch real Codex work and may use provider resources. The runner does not silently substitute models, retry failed runs, reset the router budget, or invoke Codex from the MCP runtime. It uses saved Codex authentication and removes inherited API keys from the child environment. Unknown subscription USD remains unknown. The router's existing paid-call policy and durable cap still govern its own provider operations; they do not cap host Codex subscription usage.

Failed CLI events retain only an allowlisted error category (model availability, authentication, rate limits, MCP startup, or transport) when recognizable. Raw error messages and stderr are discarded to avoid persisting credentials or private task text. Unrecognized failures retain an exit-code category. An unavailable model must be resolved explicitly and recorded; missing token counters are never treated as zero.

The benchmark runner explicitly requests a read-only host shell sandbox. MCP adapters still write their authorized artifacts through their own runtime policy. The 2026-10-12 pilot preceded this explicit flag and inherited the local CLI permission configuration; its records must not be relabeled as having used this later flag.

Defaults: `--timeout-ms 180000`, `--repetitions 1`, `--server-name harnessrouter`, `--reasoning-effort high`. `--profile` selects an existing Codex profile. A failed or timed-out CLI execution stops the repetition loop. All commands accept `--artifacts-dir /absolute/path` to select a measurement root; linked router artifacts must exist under the same root. The normal root is the router's configured `ARTIFACTS_DIR`, including the local `.env` setting.

The pinned [Codex 0.144.4 event schema](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/exec/src/exec_events.rs) defines input, cached input, output and reasoning output counters. MCP links use its `structured_content` field. Collection uses emitted events, not private Codex storage or account-wide quota deltas. CLI counter provenance is conservatively labeled `platform_estimated`; absence of counters produces `unavailable`. The recorded model is the requested CLI model, with `modelSource: requested`; JSONL does not independently confirm its runtime identity.

## Record a desktop task

Use the same case file as the task prompt. Save the task's displayed usage locally, for example:

```json
{
  "sourceLabel": "Codex desktop task usage panel",
  "model": "gpt-6.1-sol",
  "counters": {
    "input_tokens": 12000,
    "cached_input_tokens": 8000,
    "output_tokens": 600,
    "reasoning_output_tokens": 200
  }
}
```

These numbers illustrate the input format; replace them with the task's actual displayed values. A total-only panel can use `total_tokens` and will remain `partial`. Task context size is not cumulative usage and must not be entered as task tokens. Do not replace unavailable values with zero.

```bash
npm run benchmark -- record-desktop --case fixtures/benchmark-case.example.json --arm codex_harnessrouter --model gpt-6.1-sol --repetition 1 --duration-ms 45000 --thread-id YOUR_TASK_ID --usage-file /absolute/path/usage.json --harness-run-id ROUTER_RUN_UUID
```

Desktop token measurements use `manual_import`. Duration and model are supplied by the operator. `startedAt` is the record import timestamp and is labeled `timestampSource: import_time`; it is not a measured session start. Import usage into an existing CLI record with `import-usage --run-id UUID --file /absolute/path/usage.json`. The imported host record replaces the CLI host observation instead of double-counting it. Previous values are preserved in a private audit sidecar.

Link additional browser/image steps with `link-harness --run-id UUID --harness-run-id ROUTER_UUID`. A shared cached router run across benchmark records produces a warning; retrieval is not a fresh execution.

## Costs and verification

New HarnessResults use schema 1.2 with `usage[]` and `costComponents[]`; v1.1 records remain readable. Older results can be joined from their existing traces without rewriting their artifacts. Unknown legacy aggregate cost is not attributed to a specific provider.

Pi input in its installed SDK excludes cache reads/writes. The collector converts it to inclusive `inputTokens`, then retains `cachedInputTokens` and `cacheWriteInputTokens` as breakdowns. Pi session statistics include successful calls, retries and compaction recorded by that session. Reasoning splits absent from session statistics remain omitted. Failed/cancelled execution retains available observations as partial coverage. Sanitized source counters are stored in the run trace.

Decisions costs use the configured catalog rate and returned input usage; fal costs use the image profile's configured rate. These are `rate_estimate`, not invoices. Real provider-reported costs use `provider_reported`; missing costs use `unknown`. SDK estimates for subscription-backed Pi are not treated as actual subscription charges. fal output is counted as images; it is not assigned text tokens.

For a direct Codex tool's bill, import a local JSON array of cost components:

```json
[
  {
    "provider": "fal",
    "model": "fal-ai/flux-2",
    "source": "Provider receipt or local price calculation reference",
    "requestId": "ACTUAL_PROVIDER_REQUEST_ID",
    "status": "provider_reported",
    "usd": 0.02
  }
]
```

The USD value above is illustrative. Use `rate_estimate` with a recorded rate/calculation in `source` or `details` when no receipt exists. Use `unknown` and omit `usd` when unresolved. `import-cost --run-id UUID --file /absolute/path/costs.json` imports these components. A receipt supersedes a linked estimate for the same provider request in the report; the request is counted once. Subscription fees are never allocated to tasks.

Direct Codex images can be reviewed and counted with `import-media --run-id UUID --file /absolute/path/media.json --evidence "Decoded image and source output inspected: /absolute/path/image.png"`. The file is an array such as `[{"provider":"unknown","kind":"image","count":1}]`; use the actual provider/model only when exposed by source evidence. A private sidecar records manual provenance and review evidence. Include all direct outputs in one import; duplicate imports are refused. Generated images have no assumed text-token equivalent, and an unreturned image-generation charge must be imported as an `unknown` cost component. Report generation also marks text-provider usage without a matching per-task USD cost as unknown.

Grade both arms against the same prewritten acceptance criteria:

```bash
npm run benchmark -- grade --run-id UUID --outcome verified_success --evidence "Reference to the reviewed criteria and saved artifacts"
npm run benchmark -- report
```

Use `verified_failure` for failed criteria. CLI exit success or a decoded image does not automatically grade a task successful. Ungraded tasks keep overall `verifiedSuccessRate` null; `gradedSuccessRate` describes only the reviewed subset. All attempts, including failures, contribute to measured cost per verified success. No successes or missing cost data produce an unavailable ratio; unknown components make it partial.

## Data for the preview

Only local files under `artifacts/benchmark/` are generated:

- `runs/<UUID>.json`: case, arm, repetition, prompt hash, Codex identity, linked harness runs and normalized usage.
- `evidence/<UUID>-codex.jsonl`: usage/session/MCP metadata with prompts, tool arguments and response text omitted. Desktop import audit files are also kept here.
- `outputs/<UUID>.txt`: the final local Codex answer for review.
- `summary.json`: the report dataset for a future preview integration.

Files are private (`0600`) under private directories (`0700`) and ignored by Git. The report does not copy the final answer text. Records and evidence survive failed runs; a timeout requests local process cancellation, but accepted provider jobs may still bill and must be reconciled through their run/request IDs before another submission.

Report keys:

| Key | Meaning |
|---|---|
| `runs` | Per-run normalized records, preserving provenance and links |
| `byArm` | Overall observations for `codex_direct` and `codex_harnessrouter` |
| `byCaseAndArm` | Case comparisons; changed prompt hashes are split into distinct groups |
| `usageByProviderModel` | Observed token totals, per-task means, source/measurement counts and coverage |
| `mediaByProviderModel` | Image/video output units and request IDs |
| `costByProviderModel` | Reported/estimated subtotals and unknown components |
| `timing` | Completed execution median/P95 and all-attempt median, with sample count |
| `missingHarnessRunIds`, `runWarnings` | Missing evidence and reused/corrupt linked results |
| `metricDefinitions`, `costAccounting` | Definitions and subscription accounting limits |

Means use tasks with observed counters; consult the sample counts rather than assuming every attempted task was measured. Cache and reasoning counters are never added again to total tokens. Multiple calls by the same provider/model within one task are summed before computing the mean. Keep source distinctions when displaying host Codex and Pi using the same provider/model. For such a display, use the per-run `usage[].source` values rather than treating their shared model total as host-only usage.

The implementation and tests do not write to `demo/preview/` or any other demo UI file. All CLI end-to-end tests use offline fake executables and temporary directories; live comparison data has not been generated by these tests.
