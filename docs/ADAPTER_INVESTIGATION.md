# Adapter investigation

This note compares the Codex, Claude Code, and OpenCode integrations already in this repository with three newer control planes: Codex App Server, the Claude Agent SDK, and the OpenCode server. It recommends an order. It does not change runtime behavior.

The comparison is from the worker code on master `7282dd5` and from public docs read on 2026-10-23. Those docs can move. This repository has not executed `codex app-server`, the Claude Agent SDK, or `opencode serve` in CI. A later adapter must keep CI on a fake.

## What the CLI adapters do now

| | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Entry | `codex exec --json` in `src/workers/codex.ts` | `claude --print --output-format stream-json` in `src/workers/claude-code.ts` | `opencode run --format json` in `src/workers/opencode.ts` |
| Structured events | JSONL: `thread.started`, `item.completed`, `turn.completed`, `turn.failed`, `error` | stream-json: `system`, `assistant`, `result`, `error` | JSON records: `text`, `step_finish`, `error`, one `sessionID` |
| Progress | The process adapter stores each NDJSON record as `worker.raw_event` | Same | Same |
| Cancellation | The supervisor aborts the child process | Same | Same, including during the version and auth preflight |
| Resume | Not used. The invocation passes `--ephemeral` | `session_id` is parsed and not sent back | `sessionID` is required and not sent back |
| Dependency | The `codex` executable on `PATH` | The `claude` executable on `PATH` | The `opencode` executable, accepted only at version `1.18.15` |

Pi is already an SDK worker (`@earendil-works/pi-coding-agent` 1.1.0) and is outside this comparison.

Cancellation today is process death. None of the three CLI adapters send a protocol interrupt. Resume is unused on purpose: each run gets a new git snapshot, and a stored session is not that snapshot.

## Codex App Server

Public protocol: [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/).

`codex app-server` is a long-lived process shipped with the Codex CLI. The default transport is stdio, newline-delimited JSON-RPC. The docs say the `"jsonrpc":"2.0"` header is omitted on the wire. A client sends `initialize`, then an `initialized` notification, before any other method.

What it adds over `codex exec --json`:

- Structured events. After `thread/start` or `thread/resume`, the server emits `thread/*`, `turn/*`, and `item/*` notifications. `turn/start` begins a turn. `turn/completed` ends it.
- Progress. Item notifications (`item/started`, deltas, `item/completed`) are the progress stream. One client request can produce many notifications.
- Cancellation. `turn/interrupt` with `threadId` and `turnId` returns `{}` and the turn ends with `status: "interrupted"`. The docs say cancellation does not roll back tool effects that already happened.
- Resume. `thread/resume` reopens a stored thread id so a later `turn/start` appends to it. `thread/fork` copies history into a new id.

The server can also ask the client for approval and pause the turn. WebSocket listen mode is documented as experimental, and a non-loopback listener is not a fit for this router. Stdio is the transport that matches the current process supervisor.

This needs no new npm package. The next adapter can spawn the existing `codex` executable.

## Claude Agent SDK

Public docs: [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), and the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

The package is `@anthropic-ai/claude-agent-sdk`. `query()` returns an async stream of messages: `SystemMessage`, `AssistantMessage`, `ResultMessage`, and, when partial messages are enabled, raw stream events (`message_start`, `content_block_delta`, and the rest of the Claude stream). `ResultMessage.subtype` is `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, or `error_max_structured_output_retries`.

What it adds over the current `claude` CLI invocation:

- Structured events and progress. The message stream is typed. Partial stream events are incremental text and tool-input deltas. The current adapter already receives complete `assistant` and `result` events from `--output-format stream-json`.
- Cancellation. An `AbortController` passed as `abortController` stops the query. A cancelled run is reported as `error_during_execution`. The current adapter kills the CLI process instead.
- Resume. `resume` takes a `session_id`. `continue: true` resumes the newest session in the directory. Fork copies history into a new session. The current adapter records `session_id` and does not send it back.

The TypeScript reference says the SDK bundles a native Claude Code binary as a platform optional dependency, and that most installs do not need a separate `claude` binary. That is a new runtime dependency, with a native binary, and it brings its own settings merge. The current Claude worker disables inherited settings and writes a strict MCP config. An SDK session would have to be proven against that isolation before it could replace the CLI path. It should not replace it.

## OpenCode server

Public docs: [OpenCode server](https://opencode.ai/docs/server/) and [OpenCode CLI](https://opencode.ai/docs/cli/).

`opencode serve` starts a headless HTTP server. The server page describes session create (`POST /session`), a prompt (`POST /session/:id/message`), abort (`POST /session/:id/abort`), and a live event stream (`GET /event`). The CLI page says `opencode run --attach` can talk to that server, and that `opencode run` itself accepts `--format json`, `--continue`, and `--session`.

What a server would add over the current one-shot CLI:

- Structured events and progress. SSE events, plus the JSON records `opencode run --format json` already prints.
- Cancellation. `POST /session/:id/abort` instead of killing the process.
- Resume. Reuse the session id, or pass `--session` / `--continue` on the CLI.

The worker in this repository accepts only OpenCode `1.18.15`, and only after a managed-config check, a symlink-free snapshot, and an isolated `OPENCODE_CONFIG_CONTENT`. That audit is for `opencode run`. It does not cover a long-lived `opencode serve` process, a listening port, or basic-auth headers. The public server page may describe a newer OpenCode than `1.18.15`. A newer page is not evidence that the pinned CLI serves the same API.

## Recommendation

Implement in this order:

1. **Codex App Server, opt-in, stdio only.** It is the same `codex` executable, it needs no new npm dependency, and a fake JSONL peer can cover CI. The default stays `codex exec --json` with the current closed flags (`--ephemeral`, `--ignore-user-config`, `mcp_servers={}`, `features.multi_agent=false`).
2. **Claude Agent SDK, later, and only behind an optional dependency.** The gain over stream-json is a typed stream, abort, and session resume. The cost is a new package and a bundled Claude Code binary. The CLI adapter stays.
3. **OpenCode server, last.** The CLI already emits JSON events. A server is a long-lived HTTP listener outside the `1.18.15` isolation audit.

Do not turn on resume for the first server adapter. `thread/resume` and the Claude `resume` option attach a stored conversation to whatever directory the new process uses. harnessrouter creates a new snapshot per run and returns a patch from that snapshot. A resumed thread is not that snapshot. Cancellation for the first adapter should send `turn/interrupt` and still abort the process if the server does not stop.

MCP progress notifications from the run-lifecycle work are on PR #8 and are not on master. The follow-up adapter can record the same events the CLI path already records (`worker.raw_event`). Connecting those events to MCP progress waits until that branch is merged. PR #12, if it merges, adds an explicit MCP allowlist on the CLI path. The app-server opt-in must keep forwarding nothing unless that same allowlist is mapped on purpose.

The follow-up that implements item 1 should also leave the CLI adapters in place, narrow the shared worker contract enough that a new harness can be added beside them, and document that in `docs/WRITING_AN_ADAPTER.md`. Cursor and Antigravity are examples of harnesses that document is for. They are not part of this investigation.
