# Open-source release implementation

Release candidate implemented on 2026-10-17 and hardened in the 2026-10-18 final review. The current review adds canonical usage accounting, scoped probes, cancellation fixes, read-only performance reports, and the [selectable decision provider layer](DECISION_PROVIDERS.md). See [PERFORMANCE.md](PERFORMANCE.md) and the [final review](FINAL_REVIEW.md). Production sign-off and public npm publication remain pending.

| Stage | State | Evidence |
| --- | --- | --- |
| Shared contracts and keyless local routing | passed offline | Task v1.1/result v1.3; legacy readers; explicit selection, priority ties, policy/unknown-cost checks |
| OpenAI/Jev/Ollaya decision provider layer | implemented; fixtures verified; one OpenAI live decision-only check and local Ollaya smoke passed | OpenAI default; explicit provider choice; separate credentials; typed System One protocol; deterministic admission; no silent fallback |
| Snapshot/patch boundary | passed locally | Dirty content preservation, explicit untracked capture, protected paths, limits, Git tamper checks, independent patch applicability |
| Codex/Claude Code/OpenCode/Pi workers | implemented; offline verified | Structured protocol fixtures, real subprocess doubles, native controls; Pi genuine RPC lifecycle |
| Process cancellation and recovery | passed locally | Output bounds, malformed events, timeout/abort, SIGTERM-ignoring descendants, exclusive/stale leases, trace-failure release |
| CLI, packaging, onboarding and CI | implemented | init/doctor/serve/mcp-config; four host formats; MIT; optional specialists; package allowlist |
| macOS Node 22.19.0 | passed locally | Actual version checked; typecheck, 236 passing tests, 6 explicitly skipped live tests, build and package inspection |
| macOS Node 24.19.0 | passed locally | Typecheck, 236 passing tests, 6 explicitly skipped live tests, build and package inspection |
| Clean tarball install | passed locally | Optional dependencies omitted, CLI errors/version, real stdio handshake, four tools, registry and keyless host defer |
| Linux arm64 Node 22.19.0 / 24.22.0 | passed in local containers | Fresh npm install, 236 passing tests and 6 explicit live skips on each; typecheck/build/package checks; clean consumer smoke |
| GitHub Actions on merged source commit | passed | macOS and Linux runners, Node 22.19 and Node 24; all four jobs passed |
| Native four-host/four-worker matrix | not run | Requires compatible native runtimes/accounts and authorized usage |
| Live coding patches and specialist composition | not run for this release | New worker tests are opt-in; historical specialist runs are separate evidence |
| Public npm publication | not performed | Separate release action after remaining gates |

One decision-only OpenAI request selected an eligible route without executing a worker. This is API and response evidence, not a verified execution or outcome claim. No live Jev request, native worker task, or fal generation was run. A local Ollaya inference separately checked the local decision protocol. A live test skip is not interoperability proof. Applicable patches and parseable completion events do not establish semantic task success.

## Reproduce the offline checks

Use Node 22.19+ in the Node 22 line or Node 24:

```bash
npm ci
npm run check
npm run package:smoke
```

`package:smoke` installs a freshly packed tarball into a temporary consumer without optional dependencies. A fresh runner may fetch dependency metadata or tarballs from npm; it never makes model/provider calls. `npm ci` alone does not guarantee cached npm metadata. Use `npm run package:smoke -- --offline` only with a fully populated dependency and metadata cache. No provider keys are needed.

## Trust and execution defaults

OpenAI Decisions is the default selector. Jev and local Ollaya are explicit provider choices; deterministic `selector: "local"` remains available. Missing hosted credentials and authorization never cause an automatic provider switch. Project JSON/dotenv settings require `HARNESSROUTER_TRUST_PROJECT_CONFIG=true`; an explicitly selected config file is a trusted choice. Init generates disabled profiles and no workspace grants. Global/profile execution permission and per-task unknown-cost consent are separate from priced provider authorization.

Claude uses router-owned workspace MCP tools. Pi uses the pinned SDK's genuine RPC server, with explicit provider/model, controlled resources and bounded file tools. OpenCode supports the audited 1.18.15 ordinary native API/OAuth subset using isolated configuration/database; unsupported remote/managed configuration fails closed. Codex uses explicit model and native sandbox settings. These runtime controls are not a universal security sandbox.

## Remaining release gates

1. GitHub Actions passed on the merged source commit. Local checks cover macOS and Linux arm64 containers; remote GitHub runners cover macOS and Linux x64 on Node 22 and 24.
2. Supply compatible native runtime versions and choose models/accounts. The previously installed Claude Code 1.0.35 failed startup under the original Node 26 environment; newer runtime compatibility is not established by fixtures.
3. Supply a Jev credential if live Jev verification is required. The OpenAI check was one bounded request; reported-token cost estimates are not invoices.
4. Configure compatible native runtimes, choose worker models, and approve any unknown native-account usage before running host-to-worker tests, real patch tests, and specialist composition. Retain sanitized traces, model provenance and verification outcomes; repair failures before signing off.
5. Verify npm name/ownership and publish only after the release gates and separate publication authorization.

The opt-in worker commands and evidence boundaries are documented in [COMPATIBILITY.md](COMPATIBILITY.md).

## Working-tree preservation and orchestration

The release changes are prepared on a review branch; npm publication remains separate.
