# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A synchronous `route_task` sends MCP progress notifications when the host provides a progress token, so a long run can outlive the default host timeout. `async: true` returns `{runId, taskId, status: "running"}` and detaches that run from the request. `get_run` accepts `runId` or `taskId`. A `cancelled` or `interrupted` task id can run again. `completed` and `failed` stay idempotent.
- Snapshot exclusion matches control directories by exact name and secret files by filename or basename glob. Ordinary paths such as `src/hooks/useAuth.ts` and `docs/agents.md` stay in the snapshot. Cloud keys, shell credential files, Terraform state, and `.env*` files other than `.env.example` and `.env.sample` stay out. Excluded paths are recorded on `worker.started` and on the run result.
- A crashed router no longer leaves a worker lease and an `executing` run stuck. Startup and `harnessrouter reconcile` mark a dead lease `interrupted`, release it, and delete its snapshot. A live lease returns `worker_busy`.
- Run snapshots and OpenCode isolation directories are deleted after the patch or text is saved.
- Lease classification no longer depends on Linux `/proc` alone. macOS reads another process's start time from `ps` and its boot id from `kern.bootsessionuuid`. The router's own pid uses its process uptime.
- Snapshot checks accept the macOS `/tmp` and `/var` system aliases and still reject every other symlink.
- Ollaya HTTP errors keep a short sanitized provider message. A missing local model is `decision_model_unavailable`.
- Pi reports a missing API key as `WORKER_CREDENTIAL_MISSING` and keeps the runtime's first error line. The bootstrap no longer replaces every failure with `PI_RUNTIME_FAILED`.
- Built-in worker descriptions tell a review task from a patch task, so a local decision model can choose different harnesses. Pi can use a loopback OpenAI-compatible `baseUrl`.

### Added

- `route_task` input `async`.
- `harnessrouter reconcile [--dry-run]`.
- `harnessrouter prune [--older-than 7d] [--dry-run]`.
- Config `keepSnapshots` (default false), plus optional `snapshotExclude` and `snapshotInclude`.

## [1.0.0] - Unreleased

First npm release of the local MCP router. `package.json` is already at `1.0.0`. Nothing has been tagged or published. The date is filled in when the `v1.0.0` tag is pushed and the publish workflow succeeds. See [open-source release](docs/OPEN_SOURCE_RELEASE.md).

### Added

- Local MCP server that accepts one bounded task and hands it to an enabled Codex, Claude Code, OpenCode, or Pi worker. The result is text or a patch from an isolated Git snapshot.
- `harnessrouter init` writes `selector: "local"`. A new configuration routes by configured priority and does not need a decision API key. Dry run stays on, execution stays off, paid calls stay off, worker profiles stay disabled, and no workspace root is granted.
- Opt-in decision providers via `--selector decisions` or `--decision-provider openai|jev|ollaya`: OpenAI Decisions (`gpt-6-luna`), TypeSafe Jev, and loopback Ollaya. A config file or process that omits `selector` still resolves to OpenAI Decisions.
- `doctor`, `stats`, and `mcp-config` snippets for Codex, Claude Code, OpenCode, and Pi.
- Library entry at `dist/api.js`, CLI bin `harnessrouter`, and an offline `package:check` / `package:smoke` pair.
- Tag-triggered GitHub Actions publish workflow. It publishes to npm with provenance when `NPM_TOKEN` is set. It does not create the tag.

### Security

- Missing hosted credentials never switch providers. Paid selection and worker execution each require their own explicit grant.
- JSON configuration rejects credential fields. Unknown routes and provider errors fail closed.
- Starter configuration is fail-closed: workers disabled, no workspace grants, dry run on.
- Development dependency overrides move DeepEval's OpenTelemetry trace exporters to 0.223.0 and `uuid` to 11.1.1. Production dependencies are unchanged.

### Changed

- Contributor docs drop the event notes, local checkpoint reviews, and the delivery manifest.

### Existing checkout

If saved runs or budget reservations live under an older checkout's `artifacts/` directory, keep using that directory with `ARTIFACTS_DIR` or trusted `artifactsDir`. The default state directory does not import those runs. Reconcile old reservations before authorizing new priced work.
