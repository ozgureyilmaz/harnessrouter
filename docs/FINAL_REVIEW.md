# Final code and performance review — 2026-10-18

The open-source candidate passes local offline checks. It is ready for source review; full production sign-off still requires the release gates below.

## Findings addressed

| Finding | Resolution | Evidence |
| --- | --- | --- |
| Worker counters undercounted cache or reasoning; duplicated snapshots or overwritten turns | Inclusive canonical counts, distinct-message/turn merging, missing-data preservation, consistency checks and versioned `.canonical_v1` sources | `tests/unit/worker-accounting.test.ts` and worker/metering tests |
| Invalid workspace could reach paid routing selection | No-network root/include/mode preflight before offering worker routes; execution-time authority rechecked | `tests/unit/runtime-review.test.ts`: zero mocked Decisions requests for denied workspaces |
| Pinned tasks probed unrelated runtimes and repeated fresh local probes | Candidate-scoped probes; fresh local health reused; post-Decisions and stale-health rechecks retained | Pinned fixture probes unrelated workers zero times; controlled dispatch comparison below |
| Cancellation did not reach snapshot/Git/metadata work | Optional abort signals through preflight, snapshot capture/verification, native metadata subprocesses and config writes | Controlled Git and native-executable doubles terminate, prevent later commands and release leases |
| Users could not inspect comparable local measurements | Read-only CLI `stats`, optional MCP performance report, coverage/model identity/outcome/cost fields and explicit observational scope | `tests/unit/performance-report.test.ts`; clean-package MCP/CLI smoke |
| A performance view could invent legacy zeros or task identity | Legacy counters excluded from token medians; old cost fallback retained; unknown task specs/model identity explicit | Missing/partial/inconsistent/legacy fixture checks |

An independent review checked the runtime, accounting, policy and release changes. Findings were addressed and verified with local fixtures; account-level usage details are not part of this report.

## Actual performance evidence

An offline pinned-dispatch fixture confirmed the optimized path avoids unrelated worker probes and reuses fresh local health. It uses synthetic workers and excludes workspace capture and model inference, so it establishes no production speed or token savings. Corrected token accounting improves measurement accuracy but does not reduce provider token use. See [PERFORMANCE.md](PERFORMANCE.md).

## Verification

- macOS Node 22.19.0: actual runtime version checked; typecheck, full suite **236 passed / 0 failed / 6 explicit live skips**, build and package inspection.
- macOS Node 24.19.0: typecheck, full suite **236 passed / 0 failed / 6 explicit live skips**, build and package inspection.
- Linux arm64 Node 22.19.0 / npm 10.9.3 and Node 24.22.0 / npm 11.19.1: fresh installs, **236 passed / 0 failed / 6 explicit live skips** on each, typecheck/build/package checks and clean consumer smoke.
- GitHub Actions on the merged source commit: all four macOS/Linux x64 jobs for Node 22.19 and Node 24 passed, including clean package smoke.
- Clean tarball smoke verifies the installed executable, CLI error codes, optional-dependency omission, actual stdio handshake, four tools, local performance reports, registry and keyless host defer.
- Existing dirty user work is retained. No reset, broad cleanup, staging, commit, push or public publication is part of this review.

Runtime fixture tests and local packaging are not native worker/account proof. One decision-only OpenAI smoke selected an offered route; no worker executed. Hosted Jev, fal generation and native worker runs remain unverified. Consult [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md) for production gates before advertising general interoperability or superior outcomes.

## Selectable decision providers

New setups now select OpenAI Decisions (`gpt-6-luna`); Jev and loopback Ollaya remain explicit user choices. Trusted local eligibility, workspace preflight and route/model bindings remain authoritative. The provider may choose only an offered route. Missing keys, unknown IDs and provider errors never silently switch providers. Explicit route pins skip the selector without deducting its reservation from execution preflight.

Jev uses the official TypeSafe System One API with a distinct TypeSafe/Jev key. Ollaya uses its native map-based System One protocol, optional local key and zero hosted reservation. Bounded HTTP transport rejects redirects and oversized/invalid responses, propagates cancellation, and makes no automatic retry. Hosted ambiguous charges retain their budget commitment. Decision traces v1.1 include provider attribution and remain compatible with v1.0. Fixture tests verify router dispatch, token/cost attribution, zero-budget host defer and all provider setup paths.

A local Ollaya decision-only smoke selected an offered route without executing a worker. Local compute is unpriced. This protocol check establishes no comparative quality or efficiency improvement.

The implementation separated provider configuration, protocol handling, deterministic admission and execution. Worker model identities and orchestration usage are not release claims. See [DECISION_PROVIDERS.md](DECISION_PROVIDERS.md) for provider choices and enablement settings.

## Resumed release checks

The final review found and fixed a Pi permission bypass: hosted selection no longer substitutes for global execution and task unknown-cost grants. Execution eligibility now precedes selector payment admission. Sole workers, explicit route pins and static image pins use the full execution budget without requiring a selection fee; paid multi-route choices receive reserve-adjusted preflight before the provider sees them. Regressions cover all provider modes and grant combinations.

New offline integration tests exercise actual stdio MCP, loopback System One HTTP, a real fixture subprocess, isolated dirty Git snapshots, independently applicable patches and idempotent replay. Unknown routes start no worker; denied workspaces send no selector request. These are transport and policy proofs using fixtures, not native-model proof.

Cold Linux installation exposed an npm 10 override-resolution failure. A precise transformer override preserves protobuf 8.8.1 without changing dependency versions or regenerating the lockfile. The package smoke now permits npm registry access for a fresh consumer; strict `--offline` is explicit because `npm ci` does not guarantee cached metadata. Development-only PostHog declares a higher Node 22 engine floor; Node 24 is recommended for development, with details in CONTRIBUTING.md.

The active chat obtained a host-defer result without model or worker execution. The running server remains dry-run, execution-disabled and zero-budget. One isolated OpenAI decision-only check selected an eligible route without browser or worker operation. Request-level account usage and local run identifiers are kept out of this public report.
