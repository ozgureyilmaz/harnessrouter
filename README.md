# harnessrouter

task-aware execution across independent agent harnesses through MCP.

harnessrouter lets a host session delegate tasks to independently controlled harnesses and receive inspectable results. The host keeps the task context and owns the final answer. Each harness owns its tools, model configuration, execution lifecycle, and artifacts.

## why harnessrouter

Coding agents handle implementation, debugging, testing, research, automation, and many other kinds of work. Different tasks can benefit from different tools, models, context strategies, and execution environments.

The goal is to connect those environments while keeping one continuous host session. New harnesses can join through a shared interface, with explicit permissions, budgets, and result verification across handoffs.

```text
task / current host session
             ↓
local MCP gateway
             ↓
validate permissions, capabilities, health, and budget
             ↓
select an eligible harness + model route
             ↓
independent execution → verification → artifacts + traces
             ↓
return to the same host session
```

Cross-harness interoperability is the primary claim. Improvements in task success, speed, cost, or output quality remain hypotheses to test.

## current implementation

The local MVP has two independent execution paths:

- **Pi:** a real RPC agent with restricted, isolated Chrome tools for public-page inspection and screenshots.
- **fal-creative:** model-specific planning, budget admission, durable submission tracking, queue execution, bounded recovery, and decoded image verification.
- **Composition:** the host passes one run's observations into another task, preserving its parent ID and context fingerprint.
- **Host defer:** returns control to the host for host-owned work.

These are the current adapters. The routing design is broader than browser and image tasks; additional execution capabilities require implemented, authorized adapters.

Recent additions include schema 1.2 usage/cost components, evidence-backed acceptance checks, durable shared budgets, a 24-case offline harness evaluator, local benchmark metering, and a portable recorded demo.

## recorded demo and evidence

[GitHub Pages demo](https://ozgureyilmaz.github.io/harnessrouter/) · [demo files](demo/preview/) · [current status](docs/CURRENT_STATUS_REVIEW.md)

The static demo replays captured runs and displays original artifacts. It makes no provider calls. The featured native MCP workflow returned a verified screenshot and image with matching parent/context provenance. Unsupported or subjective criteria remain `unverified`; technical completion does not establish artistic quality.

A separate browser-only pilot recorded **4/4 task checks for the native host and 3/4 for Pi**: Pi omitted the exact link target. Timing boundaries differ, so these values do not establish a speed advantage. A separate host-only browser-to-image run is **partial**: it generated a real draft, but fresh-browser inspection and rendered style measurement were unavailable in that run, and the exact 16:9 check failed. Its longer elapsed time includes orchestration and interruption, so it cannot be compared directly with router processing time.

The [three-pair creative pilot](demo/creative-pilot-20261012.md) produced technically valid images in both arms, with varying speed and equal generation-price estimates. Total host/Pi USD cost is unknown; no efficiency or quality advantage has been established.

## setup

Requires Node.js **22.19+**, npm, and an MCP client. Browser execution also needs Chrome and a configured Pi provider. Image execution needs fal credentials.

```bash
npm ci
test -f .env || cp config/.env.example .env
chmod 600 .env
npm run build
```

Edit `.env` locally. Set `OPENAI_API_KEY` for Decisions and `FAL_KEY` for image generation. Configure Pi authentication through its provider settings. The template starts with paid runs disabled and dry run enabled.

For explicitly authorized live work, set `ROUTER_ALLOW_PAID_RUNS=true`, `ROUTER_DRY_RUN=false`, and finite task/session budgets. Router budgets cover priced reservations; they do not price or cap unknown host/Pi subscription usage. Keep keys out of Git and MCP arguments.

## connect through MCP

After building, configure your MCP client to start the stdio server with:

```bash
node /absolute/path/to/harnessrouter/dist/index.js
```

The server exposes `route_task`, `list_harnesses`, `get_run`, and `cancel_run`. Configure a 300-second tool timeout for long tasks. Reload the MCP connection after rebuilding.

Policy filters routes before selection. OpenAI Decisions chooses only offered route IDs; a sole eligible route is selected deterministically without a paid selection call. Refused, malformed, or unsupported requests return explicit outcomes.

## development checks

```bash
npm run typecheck
npm test
npm run build
npm run smoke:dry
npm run mcp:smoke
npm run eval:harnesses
npm run demo:check
```

Default tests and the offline evaluator use provider doubles and local fixtures. Live integration tests are opt-in; skipped live tests are not live verification. Offline eligibility checks do not measure execution success.

After supplying credentials and authorizing spend, `npm run smoke:live -- composite` exercises a fresh browser-to-image workflow. It uses the router directly; native host MCP visibility is checked separately.

## local evaluations and metering

The richer performance pilot runs 42 trials across Pi browser, both fal profiles and two composed workflows, with controlled/public browser references and GPT-6 Luna/high semantic grading. `npm run eval:pilot` checks its contracts without provider calls; `npm run eval:pilot -- --mode live --max-cost-usd 4` runs the explicitly authorized live suite. Saved-output regrading, budgets, evidence and limits are documented in [LIVE_EVALUATION.md](docs/LIVE_EVALUATION.md). The [recorded results](docs/LIVE_EVALUATION_RESULTS.md) summarize the completed pilot and its limitations.

The evaluator supports explicit direct/router paths and per-run caps. Benchmark tools record per-task usage, timing, linked runs, and graded outcomes under ignored `artifacts/benchmark/`.

```bash
npm run benchmark -- report
```

Capturing a new benchmark can launch real agent/provider work and requires separate authorization. Missing counters stay unavailable, subscription USD stays unknown, and rate estimates stay distinct from invoices. See [local metering](docs/LOCAL_METERING.md) and [experiment definitions](docs/EXPERIMENTS_AND_METRICS.md).

## GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) validates and uploads only `demo/preview/` on a push to `master` or manual dispatch. Select **GitHub Actions** in repository **Settings → Pages**. No API keys or project dependency installation are needed for deployment.

Preview the same portable files locally:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory demo/preview
```

Open <http://127.0.0.1:4173/>. The public snapshot is checked in; refreshing it on the original evidence machine uses `npm run demo:export` followed by `npm run demo:check`. See [demo publishing notes](demo/preview/README.md).

## limits

Current browser tools are public and read-only: no login, form interaction, payments, downloads, or private profiles. Creative execution supports images only. Arbitrary harness packages, video, and learned routing policies are outside the current implementation.

Runs persist sanitized traces, verification results, and artifacts locally. Reusing a task ID reconciles saved work; ambiguous paid submissions are never automatically repeated. Unknown spend retains its reservation across restarts. Do not reset the budget ledger to bypass the cap.

[Architecture](docs/ARCHITECTURE.md) · [runbook](docs/RUNBOOK.md) · [security and cost](docs/SECURITY_AND_COST.md) · [delivery boundary](docs/DELIVERY_ALLOWLIST.md)
