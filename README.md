# harnessrouter

Delegate a bounded task from your current agent to an independent Codex, Claude Code, OpenCode, or Pi worker through local MCP. Get back text or a reviewable patch, with artifacts and execution traces. Your host session keeps the context and owns the final answer.

The primary claim is **cross-harness interoperability**. Better outcomes, speed, cost, and quality remain hypotheses that require experiments. Worker protocols are implemented and checked offline; a complete live host/worker matrix is **not verified**. Runtime capability checks can make a configured worker unavailable. See [compatibility](docs/COMPATIBILITY.md).

## Install

MIT licensed. Targets macOS and Linux on Node.js **22.19+ in the Node 22 line, or Node 24**. Use WSL2 on Windows; native Windows is not supported. The CI matrix covers macOS/Linux and both Node lines; configured CI is not evidence of a completed remote run.

Use a repository checkout until an npm release has actually been published:

```bash
git clone https://github.com/ozgureyilmaz/harnessrouter.git
cd harnessrouter
npm ci
npm run build
npm link --ignore-scripts
```

A locally built tarball can also be installed with `npm install -g /absolute/path/to/harnessrouter-VERSION.tgz`. After publication, registry installation will be `npm install -g harnessrouter`; publication is a separate release gate.

## Configure a worker

Install your selected native runtime and authenticate through its own supported login or provider configuration. harnessrouter does not copy credentials into its JSON configuration. Worker models remain explicit local choices; routing does not discover runnable worker models or switch providers for you.

```bash
harnessrouter init --config ./harnessrouter.config.json
harnessrouter doctor --config ./harnessrouter.config.json
```

`init` writes disabled examples with dry run enabled. For a Codex worker, replace the generated configuration with the following, substituting a real repository path and a model supported by your installed runtime/account:

```json
{
  "selector": "local",
  "dryRun": false,
  "allowExecution": true,
  "allowPaid": false,
  "workspaceRoots": ["/absolute/path/to/project"],
  "workerProfiles": [
    {
      "id": "codex-main",
      "adapter": "codex",
      "model": "REPLACE_WITH_SUPPORTED_MODEL",
      "enabled": true,
      "allowExecution": true,
      "allowUnknownCost": true,
      "priority": 10,
      "timeoutMs": 120000
    }
  ]
}
```

The example above explicitly opts out of decision-provider selection and uses local route priority or a task's `preferredRouteId`. `init` itself defaults to `selector: "decisions"` with the OpenAI Decisions provider; its dry-run and execution gates remain closed.

This explicitly authorizes independent worker execution and usage whose per-run USD charge is unknown. Native subscriptions or API accounts may incur usage even with `allowPaid: false`; that switch does not establish a zero-cost native worker. Every worker task must also set `allowUnknownCost: true`. Dry run validates routing without launching a worker.

Run `doctor` again after editing. It checks local configuration and runtime compatibility; it does not prove authentication or make a model call. An incompatible runtime stays unavailable.

Configuration defaults to `$XDG_CONFIG_HOME/harnessrouter/config.json`, or `~/.config/harnessrouter/config.json`; project configuration in `.harnessrouter/config.json` is loaded only with `HARNESSROUTER_TRUST_PROJECT_CONFIG=true`. Use `--config` or `HARNESSROUTER_CONFIG` for an explicit path. The same explicit trust flag enables project `.env` defaults; process environment takes precedence. Explicit `--config` files are trusted choices. Runtime data belongs outside the installed package, by default under `~/.local/state/harnessrouter`.

## Connect your host and delegate

Print an MCP configuration snippet for your host:

```bash
harnessrouter mcp-config --host codex --config ./harnessrouter.config.json
```

Supported host names are `codex`, `claude-code`, `opencode`, and `pi`. Add the generated configuration through that client's normal MCP setup and reload its connection. The command prints configuration; it does not edit your host settings. `harnessrouter serve` starts the stdio server; running `harnessrouter` without a subcommand also serves MCP.

The server exposes four tools: `route_task`, `list_harnesses`, `get_run`, and `cancel_run`. First inspect `list_harnesses`, then submit a read-only task with `route_task`:

```json
{
  "schemaVersion": "1.1",
  "taskId": "readme-review-001",
  "prompt": "Read README.md and identify up to three concrete documentation gaps. Do not edit files.",
  "requirements": ["review"],
  "acceptanceCriteria": [],
  "desiredOutput": "text",
  "preferredRouteId": "codex-main:configured",
  "allowUnknownCost": true,
  "workspace": {
    "root": "/absolute/path/to/project",
    "mode": "read-only"
  }
}
```

Use `requirements: ["coding"]`, `desiredOutput: "patch"`, and `workspace.mode: "patch"` for an edit. Add relative file paths to `workspace.includeUntracked` only when those untracked files are needed. Use a new task ID for new work; inspect `get_run` after a timeout before retrying a saved task.

Decision selection defaults to the OpenAI Decisions API, pinned to `gpt-6-luna`. Set `decisionProvider: "jev"` or `ROUTER_DECISION_PROVIDER=jev` to choose TypeSafe JEV; the TypeSafe key supplies credentials and never switches providers. Ollaya uses its local TypeSafe-compatible System One API at `http://127.0.0.1:11435` by default. Set `selector: "local"` to opt out and use configured route priority or a task's `preferredRouteId`. Missing credentials or endpoint settings fail closed; harnessrouter never silently switches provider or falls back to local ranking. The decision model does not determine the worker's model. See [decision provider configuration](docs/DECISION_PROVIDERS.md).

## Compare local time and token measurements

```bash
harnessrouter stats --config ./harnessrouter.config.json --task-type coding --sort time
harnessrouter stats --config ./harnessrouter.config.json --task-type coding --sort tokens --json
```

The report shows measured elapsed time, canonical token counts, data coverage, criterion outcomes, and unknown costs. It excludes host conversation usage. MCP clients can request `list_harnesses` with `includePerformance: true`. Default listing stays unchanged.

Use the report to choose `preferredRouteId` or trusted profile priorities. Sorting does not change routing or prove equivalent quality. Cached input and reasoning are counted once; missing and legacy counters are not zeros. See [performance measurements and limits](docs/PERFORMANCE.md).

## Workspace and result boundary

Workers receive an isolated Git snapshot of current tracked content, including existing dirty edits and deletions. Untracked files require explicit inclusion. Original repositories are never automatically patched. Snapshot policy excludes known secret filenames, agent instructions, hooks, inherited harness settings, `.git`, and dependency directories; symlinks, hardlinks, and unsafe paths are rejected.

Patch results include `workspace.patch`, a changed-file manifest, the captured baseline fingerprint, and a SHA256 digest. Applicability is checked against the captured baseline. Review the patch and account for subsequent source edits before applying it yourself. Applicable does not mean semantically correct. Read-only writes, protected-file writes, Git metadata tampering, and empty requested patches fail explicitly.

Native workers are not uniformly sandboxed by the operating system. File exclusions and runtime tool restrictions do not guarantee prevention of writes elsewhere or recognition of secrets hidden under arbitrary filenames. See [security](SECURITY.md) and [adapter boundaries](docs/ADAPTERS.md).

## Optional Pi browser and fal image specialists

From a source checkout, the existing specialist routes remain opt-in: Pi runs a real RPC agent with isolated public-browser tools; fal uses model-specific planning, budget admission, durable request tracking, bounded recovery, and decoded image verification. Host composition passes observations into a separate task with parent/context provenance. Browser tools do not support login, forms, payments, downloads, or private profiles. Image generation is supported; video is disabled.

For local setup, copy `config/.env.example` to an ignored `.env`, protect it with `chmod 600 .env`, and edit it locally. Set `HARNESSROUTER_TRUST_PROJECT_CONFIG=true` only after reviewing that project configuration. `OPENAI_API_KEY` supplies the OpenAI Decisions credential and may also be used by a Pi OpenAI provider; `TYPESAFE_API_KEY` (or the `JEV_API_KEY` alias) is separate, and `OLLAYA_API_KEY` is optional and local-only. `FAL_KEY` supplies fal. Configure Pi through its documented provider authentication, without inventing a `PI_API_KEY`. Hosted paid selection and specialist work require `ROUTER_ALLOW_PAID_RUNS=true`, `ROUTER_DRY_RUN=false`, and finite approved budgets. Pi browser execution always requires `ROUTER_ALLOW_EXECUTION=true` and task `allowUnknownCost:true`, regardless of the decision provider. Unknown native host/Pi subscription USD is not capped by priced reservations. `doctor` reports credential presence and configured loopback URLs only; it makes no provider or model request.

Existing daily-use examples remain in [config/daily-tasks.json](config/daily-tasks.json):

```bash
npm run domain:allow -- developer.mozilla.org
npm run task:compose -- <browser-run-id>
```

Reload MCP after changing allowlists or rebuilding. `ROUTER_IMAGE_ROUTE=fast|quality` pins an image profile and skips a selection call; task `creativeOptions.quality=fast|high` overrides it. `auto` allows both profiles. Browser link targets are measured into `websiteObservations.links`; the corresponding acceptance criterion is `Measured href`.

## Development and evidence

```bash
npm run typecheck
npm test
npm run build
npm run package:check
npm run package:smoke
```

Default tests use local fixtures/provider doubles; skipped opt-in live tests are not live evidence. CI supplies no provider credentials and makes no model calls. Contributor setup and verification are in [CONTRIBUTING.md](CONTRIBUTING.md); protocol details and extension interfaces are in [ADAPTERS.md](docs/ADAPTERS.md).

The [recorded Pages demo](https://ozgureyilmaz.github.io/harnessrouter/) replays captured specialist artifacts without provider calls. Its native MCP composition produced a verified screenshot and image, with subjective criteria left unverified. These historical runs do not establish the new worker matrix. A browser-only pilot recorded native 4/4 versus Pi 3/4 task checks with different timing boundaries. A host-only composed run remained partial and failed exact 16:9. The [three-pair creative pilot](demo/creative-pilot-20261012.md) established no quality or efficiency advantage; total host/Pi USD was unknown.

More evidence: [current review](docs/CURRENT_STATUS_REVIEW.md), [live pilot methods](docs/LIVE_EVALUATION.md), [recorded pilot results](docs/LIVE_EVALUATION_RESULTS.md), [metering](docs/LOCAL_METERING.md), and [release gates](docs/OPEN_SOURCE_RELEASE.md). `npm run eval:pilot` checks contracts offline; live evaluation/benchmark commands launch real work and require execution/spend authorization. Missing counters remain unavailable and estimates remain distinct from invoices.

The existing [Pages workflow](.github/workflows/pages.yml) publishes only `demo/preview/`. See [demo publishing notes](demo/preview/README.md) for export/validation. Preview with `python3 -m http.server 4173 --bind 127.0.0.1 --directory demo/preview`.

[Architecture](docs/ARCHITECTURE.md) · [runbook](docs/RUNBOOK.md) · [security and cost](docs/SECURITY_AND_COST.md) · [license](LICENSE)
