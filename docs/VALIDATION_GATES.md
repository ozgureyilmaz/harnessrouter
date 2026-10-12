# Validation gates & acceptance matrix

Do not imply a gate passed unless its evidence exists. Latest local checks and fresh native calls are recorded in `docs/BUILD_LOG.md` and `demo/native-mcp-verification.json`. G4/G5 now pass for the supported mechanical criteria: the final browser/image pair returned schema 1.2 with usage/cost fields, and native get_run matched persisted results. Image similarity is explicitly unverified.

| Gate | Must prove | Negative path | Evidence |
|---|---|---|---|
| G0 | Node/Pi/Chrome present; packages version compatible; auth flags known | Missing key, incompatible extension | `docs/BUILD_LOG.md` version/readiness log |
| G1 | Decisions selects valid provided route from real choice request | Refusal, invalid route, timeout, zero candidates | redacted input, response, latency and `runId` |
| G2 | Creative harness independently produces validated image | Over-budget; queue error; bad MIME/URL; timeout | fal request ID, saved image, model, execution trace |
| G3 | Pi independently performs browser task and screenshot | Pi crash, malformed JSONL, tool unavailable, dangerous URL | Pi RPC trace and verified screenshot path |
| G4 | Current Codex calls native MCP `route_task` and receives one fresh typed result | Disconnected MCP, stale process, unrecognized route | fresh run ID, schema 1.2 result with `usage`/`costComponents`, artifact and trace; cached replay proves retrieval only |
| G5 | Current Codex makes two fresh MCP calls for one objective; the second consumes observations from the first | Missing prior artifact, stale criterion evaluator, tool refusal | two fresh run IDs, parent link/fingerprint, two verified artifacts, current criterion results, metering fields and traces |
| G6 | Repeatable demo without leaking secrets; README instructions run | provider downtime/replay confusion | measured log and clearly labeled recorded fallback |

## Test plan

### Unit (offline, no credentials)

- Schema required fields invalid → reject.
- Explicit `requiredCapabilities` unsupported by every harness → no route and no Decisions request.
- One eligible specialist route → deterministic selection with decisionStatus not_required; paid Decisions disabled → no external route.
- Known artifact/browser criteria are evaluated from stored evidence; unsupported prose criteria remain `unverified`.
- Historical result v1.0 is surfaced as v1.2 with criteria marked `unverified`; v1.1 reads retain original criterion statuses and do not invent missing usage. No provider work is repeated.
- Unsupported modality/sensitive domain → candidate removal.
- Not authorized or unavailable route → excluded.
- Route table never includes undeclared Pi+model combination.
- Decisions response selection not in choices → hard fail (not executed).
- Refusal and confidence missing → explicit fallback policy.
- Budget check with unknown pricing → `not_budget_verifiable`/reject when hard budget requires it.
- Timeout cancellation propagates from MCP to harness process/queue if supported.
- Pi RPC output split across chunks still parses newline-framed JSON correctly.
- Reject prompt-injected webpage instructions requesting secret disclosure.
- Duplicate fal queue submit after ambiguous disconnect is prevented / state recovered by request ID.
- Artifact 404/HTML masquerading as image → fail verification.

### Integration (local, opt-in)

- Pi RPC simple `Hello` turn (provider configured).
- Pi browser opens harmless example site, reads title, creates screenshot.
- fal low-cost image call, saves file, verifies dimensions and MIME.
- Decisions live smoke with allowed options returns correct typed envelope.
- MCP stdio tool roundtrip returns the result object, not only prose.

### Full e2e (live provider cost, explicit consent)

1. Codex → MCP → Decisions → Pi: inspect a preapproved public URL and capture screenshot.
2. Codex → MCP → Decisions → Creative: generate 16:9 branded hero using prior structured observations.
3. Verify both assets and traces; hand final result back in same Codex session.

## Routing evaluation fixtures

See `fixtures/evaluation-tasks.json`. Labels are expected **eligible route families**, not evidence of model quality. Compute accuracy against eligible route labels with a confusion matrix. Do not call it an "efficiency benchmark".

## Deterministic success criteria

- **Real Pi**: command/control occurred through a Pi child process, screenshot exists, is nonzero and decodes.
- **Real fal**: request has an actual provider ID, returned image is fetchable/decoded; no hardcoded URL.
- **Real Decisions**: actual `/v1/decisions` response stored with secrets removed; selected ID valid for that run.
- **Honest traces**: elapsed milliseconds measured from clock; cost may be `unknown`; no invented confidence.
- **Composite**: second task received content collected by first (e.g., extracted palette or screenshot metadata), not a separately hardcoded generic prompt.
