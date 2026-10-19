# Compatibility and evidence

A supported protocol means an implementation exists. Offline verification means fixtures/local subprocesses exercise it. Live verification requires a real authorized host-to-worker task and verified output. These are separate claims.

## Platform target

| Environment | Target | Evidence boundary |
| --- | --- | --- |
| macOS, Node 22.19+ in Node 22 / Node 24 | Supported target | Local 22.19/24.19 checks pass; remote CI remains separate |
| Linux, Node 22.19+ in Node 22 / Node 24 | Supported target | Local arm64 containers pass fresh installs and checks on 22.19/24.22; remote CI and amd64 remain separate |
| Windows through WSL2 | Linux execution path | No native Windows support claim; WSL2 execution not live verified |
| Node 26 | Outside release target | Local observations do not establish Node 22/24 compatibility |

The development environment contains an executable path named `node@22` that reports Node 26. Treat actual `node --version` output as evidence. No runtime path label overrides version checks.

## General workspace workers

All four protocols are implemented with offline tests. None has a completed live cross-host/worker matrix in this release. Authentication remains with the native runtime and is not proven by a help/version probe.

| Worker | Native execution | Availability gate | Live status |
| --- | --- | --- | --- |
| Codex | `codex exec` JSONL with explicit model, ephemeral execution, ignored user configuration, and native workspace permissions | Required installed CLI flags and local profile permissions | Unverified |
| Claude Code | Print/stream JSON with explicit model, restricted settings and a bounded workspace MCP | Required CLI flags; compatible runtime startup | Unverified; installed 1.0.35 fails startup under observed Node 26 |
| OpenCode | Structured `run` protocol, explicit provider/model and restrictive tool permissions | Safe native API/OAuth profile subset only; fail closed if remote/well-known or organization metadata could load inherited configuration | Unverified; metadata preflight may keep a profile unavailable |
| Pi | Pinned `@earendil-works/pi-coding-agent` 1.1.0 RPC bootstrap with explicit provider/model and controlled tools | Required SDK exports, provider/model match, no executable override | Unverified |

A configured route can remain unavailable because its installed native version lacks the controls required for isolation. Never remove those gates merely to make a compatibility cell appear supported. Native credentials can be absent or invalid even when the runtime probe succeeds.

OpenCode remote/well-known and organization profiles are blocked when their inherited MCP/settings cannot be safely excluded. A native API/OAuth account is eligible only after the local metadata preflight establishes the supported subset; do not describe every OpenCode login as supported.

Worker capabilities are bounded text/review tasks and repository edits returned as patches. Tasks require an allowed absolute Git root; edits require `desiredOutput: "patch"` and workspace `mode: "patch"`. Native worker USD cost is unknown unless reliable evidence says otherwise; explicit profile/task acceptance of unknown cost remains required.

## MCP hosts

`mcp-config --host codex|claude-code|opencode|pi` emits host-specific configuration. Generating a snippet proves formatting only. A client must load it, expose the four tools, invoke a bounded task, and receive verified output before that pairing is live verified. A four-host/four-worker matrix remains pending.

The host retains control of the final response. Same-kind worker execution is an explicit local opt-in and must not silently create a nested host session. Workers cannot recursively delegate through harnessrouter.

## Specialist paths and historical evidence

Pi browser and fal image adapters have existing recorded specialist runs, including native MCP composition with verified screenshot/image artifacts. That evidence covers the particular versions, tasks, paths, and permissions recorded; it does not certify every new worker protocol, host, runtime, or model.

Read the [current review](CURRENT_STATUS_REVIEW.md), [pilot results](LIVE_EVALUATION_RESULTS.md), and [release gates](OPEN_SOURCE_RELEASE.md) for evidence and unresolved limits. No controlled advantage in total cost, quality, or speed has been established.

## Opt-in worker proof

After approving native-account usage and selecting compatible models/profiles in trusted configuration, run:

```bash
HARNESSROUTER_CONFIG=/absolute/path/to/config.json \
HARNESSROUTER_LIVE_WORKERS=1 HARNESSROUTER_ACCEPT_UNKNOWN_COST=1 \
npm test
```

This can consume native subscription/API usage with unknown USD. It performs one controlled patch task per enabled worker kind, without retrying model tasks, and retains traces/patches under ignored `artifacts/live-workers/`. Missing configuration/runtime produces an explicit skip and does not certify that worker. These tests exercise router-to-worker execution; the full matrix of native MCP hosts remains a separate gate.
