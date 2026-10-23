# Choosing routes using measured performance

harnessrouter exposes local measurements so users can choose a route. It does not promise that routing improves every task, model, token count, or elapsed time. Host conversation usage is outside the saved router result unless separately imported into a controlled benchmark.

## Inspect time and tokens

After explicitly authorized tasks have saved results, run:

```bash
harnessrouter stats --config /absolute/path/to/config.json --task-type coding --sort time
harnessrouter stats --config /absolute/path/to/config.json --task-type coding --sort tokens --json
```

`--task-type` filters a requirement such as `coding`, `review`, `browser`, or `image`. Without it, distinct task types remain separate rows. `--limit` bounds inspected run directories (default 1,000, maximum 5,000). The bounded directory sample is not guaranteed to contain the latest runs.

From an MCP host, `list_harnesses({"includePerformance":true})` adds a bounded 250-run report. Default `list_harnesses` does not scan history. CLI `stats` reads local result/task files only and does not start runtimes, inspect native authentication, mutate ledgers, or call providers.

Rows expose route and model identity, completed/attempted counts, recorded criterion outcomes, measured latency, token coverage, and known/estimated USD subtotals. `configured` model identity means the runtime did not independently report a physical model. `unknown` and `mixed` identities remain visible. Missing task metadata has no invented distinct-case count.

Ordering by `time` or `tokens` is a display choice. That display order does not change routing. Copy the chosen route ID into `preferredRouteId`, or set a trusted worker profile's `priority`.

`selectionFeedback` (config) or `ROUTER_SELECTION_FEEDBACK` can also read this report. It is off by default, so keyless local priority is unchanged until you set it to true. A strictly higher `priority` still wins. Equal top priorities can be separated by saved success rate, then median time, then median tokens, for that same task type, and only when every tied route has at least one saved attempt. Missing history is not treated as a score of zero. The decision trace records whether the observations changed the route. Hosted decision prompts are left unchanged. Policy and availability checks still apply; unavailable routes never become eligible because their historical numbers look good.

## Read the measurements correctly

- Total time is router-observed elapsed time, including eligibility, handoff, worker execution, verification, and local tracing up to the recorded result boundary. Worker execution time includes process/trace overhead; it is not pure model inference time.
- Latency and token medians describe completed runs. Failures, cancellations and usage coverage remain visible separately. Criteria passes can be technical artifact checks; they do not establish independently graded usefulness.
- Canonical input includes cache-read and cache-write input. Canonical output includes reasoning when the native protocol reports reasoning separately. Cache and reasoning subsets are never added again to the canonical total.
- Token medians require complete, consistent canonical provider counters. Missing or partial counters are not treated as zero. Older unversioned general-worker counters are retained but excluded from comparable token medians.
- New normalized worker records use `.canonical_v1` source labels. Earlier records are not silently rewritten. Different model tokenizers mean fewer tokens alone is not proof of less money or equal quality.
- USD subtotals distinguish reported/known and estimated values. Unknown charges stay unknown, including subscription-backed native accounts. A subtotal with unpriced runs is not the total bill.

## Establish a real improvement

Use the same tasks, captured starting content, output requirements, permission limits, and grading procedure for both arms. Alternate or randomize arm order, repeat each case, include failures and cancellations, and record host, router, and worker usage separately. Compare quality-qualified results and total time; a fast incorrect answer is not an improvement. Record runtime/model versions and report uncertainty and missing counters.

`stats` groups observational runs by route/model/task type; it is not a controlled experiment. The existing benchmark tooling can retain host usage and linked run IDs, while the opt-in worker tests establish execution/patch evidence. Native host interoperability and provider-backed performance remain separate release gates. No new live performance claim is established by the offline checks below.

## Verification scope

An offline pinned-dispatch fixture confirmed that explicit pins skip unrelated runtime probes and reuse fresh local health. It uses synthetic workers and checks fixture artifacts. It does not include workspace capture or model inference and establishes no production latency, token savings, or answer quality. Post-selection liveness checks remain mandatory. Reproduce the offline checks with `npm test`; use the controlled benchmark tooling for measurements from real tasks and accounts. See the [release gates](OPEN_SOURCE_RELEASE.md) before making production performance claims.
