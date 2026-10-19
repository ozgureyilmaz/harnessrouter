# 1.0.0 release candidate

harnessrouter now provides a host-neutral local MCP gateway with explicit Codex, Claude Code, OpenCode and Pi worker profiles. The current host retains its conversation and final response; workers execute bounded tasks independently.

- OpenAI Decisions selection by default, explicit user choices for hosted TypeSafe Jev or local Ollaya, and deterministic local routing as an opt-out. Explicit route selection skips decision calls.
- Isolated project snapshots with reviewable, independently checked patches; original working trees stay unchanged.
- Controlled worker settings, bounded subprocess output/time, cancellation, exclusive leases, idempotency and reconciliation.
- npm executable and library entrypoint, init/doctor/host configuration commands, MIT license, contributor/security/adapter guides, and offline CI.
- Existing Pi browser and fal image specialists remain available with their existing permission and budget boundaries.

Task schema 1.1 and result schema 1.3 extend the existing contracts. Saved legacy results remain readable. New worker tasks must include workspace input and explicit unknown-cost consent. Project JSON and dotenv settings now require explicit project trust; process environment takes precedence. Writable state defaults outside the installed package.

This candidate passes local offline checks on Node 22/24 and includes a live OpenAI decision-only check. The source pull request will run the remote CI matrix. Native host/worker verification and npm publication remain separate release steps. See [release gates](OPEN_SOURCE_RELEASE.md).

## Existing checkout migration

If you have saved runs or budget reservations under the previous checkout's `artifacts/`, keep using that exact directory with explicit `ARTIFACTS_DIR=/absolute/path/to/old/artifacts` or trusted `artifactsDir` configuration. Do not discard, replace, or clear its budget ledger to bypass unresolved spend. The new default state location does not automatically import historical runs or reservations. Inspect/reconcile old runs before authorizing new priced work.

## 2026-10-18 final review

Corrected token undercounting and duplicate usage across all four workers. New canonical records include cache and reasoning once, keep distinct turns/messages, and preserve missing data; `.canonical_v1` labels distinguish them from earlier counters. This improves accounting accuracy and is not a token-consumption reduction claim.

Pinned tasks probe only compatible/requested runtimes and reuse fresh local health, while post-Decisions checks remain. Workspace authority is preflighted before paid routing selection. Cancellation now reaches workspace scans, Git operations, and native metadata checks.

Added read-only CLI `stats` and opt-in MCP performance summaries for route choice, with coverage, model identity, outcomes, costs and explicit observational limits. See [PERFORMANCE.md](PERFORMANCE.md). Production and live performance gates remain open.

## 2026-10-18 decision provider layer

New setups select OpenAI Decisions (`gpt-6-luna`). Users can choose TypeSafe Jev with a separate API key or a loopback Ollaya model. The two System One providers use their native map-based protocol, not the OpenAI Decisions request schema. See [configuration and enablement examples](DECISION_PROVIDERS.md).

Selection runs only after deterministic eligibility and workspace preflight. Unknown route IDs fail; provider errors never silently choose another provider. Local inference has no hosted reservation, while hosted ambiguous charges retain their reservation. Provider/model, latency and token usage are recorded separately from worker usage. Decision traces are now v1.1; v1.0 remains readable. Existing explicit `selector: "local"` settings keep their behavior.

Dry run, disabled worker profiles, separate execution grants and paid-call gates remain the starter defaults. A local Ollaya smoke and one OpenAI decision-only check selected offered routes without worker execution. Jev and the native worker matrix remain unverified. No comparative quality, time or token improvement is established by these checks.
