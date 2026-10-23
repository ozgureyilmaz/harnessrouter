# Writing an adapter

harnessrouter stays a router. A new harness, such as Cursor or Antigravity, is trusted application code. Task input and registry text never select an executable or import a module.

There are two contracts. Pick the smaller one that fits.

## A whole harness

Implement `HarnessAdapter` in `src/domain/types.ts`: `id`, `health()`, and `execute(task, context)`. Add `preflight` when the run needs a check before selection. Register the instance in `src/create-router.ts`. Add a manifest the registry loader already knows how to validate.

`execute` returns text or a patch artifact. It does not apply the patch to the user's repository, and it does not put secrets in the trace. `context.signal` is the cancellation signal.

## A subprocess worker

Implement `WorkerProtocol` in `src/workers/types.ts` and register it in `src/workers/catalog.ts`. Extend the profile schema in `src/workers/config.ts` with a closed adapter name. `ProcessWorkerAdapter` in `src/workers/adapter.ts` then owns the lease, the git snapshot, the prompt from `workerTaskPrompt`, the process limits, and patch collection.

A one-shot CLI fills `invocation` and `parse`. `invocation` returns an argv and optional stdin. `parse` reads the JSON records and fails closed on a missing terminal event.

A bidirectional server fills `stdioSession` as well. The session's `opening` is the first stdin payload. `respond` answers one server record. `interrupt` is written on cancellation, and the supervisor still kills the process if it does not exit. Return a `failure` instead of approving a request you did not expect. The Codex App Server session in `src/workers/codex-app-server.ts` is the example: `codexTransport: "app-server"` opts in, and an omitted transport stays `codex exec`. That CLI path still passes `--ignore-user-config`. It passes `mcp_servers={}` until the profile sets `mcpServers`. The app-server argv is only `app-server --listen stdio://`. It does not forward `mcpServers` or route-profile `allowedMcpServers`. A route profile still supplies the model, the read-only or patch mode, and the prompt. A Codex config under `CODEX_HOME` can still load. The opt-in is not a second closed default.

## Rules that stay in place

- The default for a new switch is off.
- Do not resume a stored session onto a new snapshot. The snapshot is per run.
- Do not add a runtime dependency for a protocol you can speak over stdio.
- Workers already have `HARNESSROUTER_WORKER=1`. Do not spawn another harnessrouter.
- CI uses a fake subprocess. A live CLI run is a separate, explicit check.

A synchronous `route_task` already emits MCP progress for `validating`, `selecting`, `executing`, and `collecting`. Record server records with `worker.raw_event`. Feeding those records into the progress notification is separate from the protocol.
