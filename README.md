# harnessrouter

🧭 *one agent. many harnesses. one reviewable result.*

local mcp router. your current agent hands a bounded task to codex, claude code, opencode, or pi, and gets text or a patch back.

[![CI](https://github.com/ozgureyilmaz/harnessrouter/workflows/Offline%20checks/badge.svg)](https://github.com/ozgureyilmaz/harnessrouter/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ozgureyilmaz/harnessrouter)

## features

cross-harness workers: codex, claude code, opencode, and pi stay independent. mcp is the gateway.

route choice: pin a worker, use local priority, or let a decision provider pick among routes that are already eligible.

isolated work: the worker gets a git snapshot. edits return as a patch. your repository is not changed for you.

inspectable runs: `list_harnesses`, `route_task`, `get_run`, and `cancel_run`.

## how it works

```mermaid
flowchart TD
    Host[Host agent] --> MCP[harnessrouter MCP server]
    MCP --> Filter[Eligible routes]
    Filter --> Pick{How is the route chosen?}
    Pick -->|"preferredRouteId or one route"| Direct[Use that route]
    Pick -->|local priority| Rank[Highest configured priority]
    Pick -->|decisions| Provider[Decision provider]
    Provider --> Offered{Id was eligible?}
    Offered -->|no| Closed[Fail closed]
    Direct --> Kind{Worker or host?}
    Rank --> Unique{Unique top priority?}
    Unique -->|no| Defer[Defer to the host]
    Unique -->|yes| Kind
    Offered -->|yes| Kind
    Kind -->|host| Defer
    Kind -->|"codex, claude code, opencode, or pi"| Adapter[Worker adapter]
    Adapter --> Snap[Isolated Git snapshot]
    Snap --> Result[Text or patch]
    Result --> Host
    Defer --> Host
```

the decision provider chooses a route id. it does not choose the worker model. openai decisions uses `gpt-6-luna`. typesafe jev and local ollaya are the other providers. a bad id, or a provider error, stops the run instead of switching providers. see [decision providers](docs/DECISION_PROVIDERS.md) and [architecture](docs/ARCHITECTURE.md).

```mermaid
sequenceDiagram
    actor User
    participant Host as Host agent
    participant MCP as harnessrouter MCP
    participant Selector as Selector
    participant Worker as Worker adapter

    User->>Host: Bounded task
    Host->>MCP: list_harnesses
    MCP-->>Host: Routes, health, and policy
    Host->>MCP: route_task
    MCP->>MCP: Validate the task and keep eligible routes
    alt preferredRouteId, one route, or local priority
        MCP->>Selector: Select without a provider call
    else decisions selector and several routes
        MCP->>Selector: Choose among eligible route ids
        Selector-->>MCP: Route id
        MCP->>MCP: Accept the id only if it was offered
    end
    MCP->>Worker: Run Codex, Claude Code, OpenCode, or Pi
    Worker->>Worker: Prepare an isolated Git snapshot
    Worker-->>MCP: Text or patch
    MCP-->>Host: Result and runId
    opt Saved run
        Host->>MCP: get_run(runId)
        MCP-->>Host: Result, decision, and status
    end
    opt Still running
        Host->>MCP: cancel_run(runId)
        MCP-->>Host: cancelled true, or false if it already finished
    end
    Host-->>User: Review the text or patch
```

the same `taskId` returns a finished run. if a call times out, use `get_run` before sending that task again.

## requirements

macos or linux. windows through wsl2.

node.js 22.19+ on the node 22 line, or node 24.

git, and at least one worker installed and signed in on its own.

## install

until an npm release is published, install from a checkout:

```bash
git clone https://github.com/ozgureyilmaz/harnessrouter.git
cd harnessrouter
npm ci
npm run build
npm link --ignore-scripts
```

the command is `harnessrouter`. after `npm pack`, a local tarball installs with `npm install -g /absolute/path/to/harnessrouter-1.0.0.tgz`.

## setup

create a starter file. it ships with dry run on, execution off, and every worker disabled:

```bash
harnessrouter init --config ./harnessrouter.config.json
```

enable one worker. use a model your installed runtime accepts, and an absolute project path:

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

```bash
harnessrouter doctor --config ./harnessrouter.config.json
```

`doctor` checks node, git, and the worker cli. it does not call a model. worker logins stay in each harness. this file does not store them.

`init` defaults to `selector: "decisions"`. the example above uses local priority so one worker can run without a decision call. a worker can spend its own subscription or api account, and the usd amount may be unknown, so each task sets `allowUnknownCost` to true.

config defaults to `~/.config/harnessrouter/config.json` (`$XDG_CONFIG_HOME` when set). run data defaults to `~/.local/state/harnessrouter`. process environment overrides the file. spend and snapshot limits: [security and cost](docs/SECURITY_AND_COST.md).

print an mcp snippet and paste it into the host. this does not edit host settings:

```bash
harnessrouter mcp-config --host codex --config ./harnessrouter.config.json
```

hosts are `codex`, `claude-code`, `opencode`, and `pi`. reload the host after you add the snippet. `harnessrouter` with no subcommand serves mcp on stdio.

## usage

### cli

```bash
harnessrouter doctor --config ./harnessrouter.config.json
harnessrouter stats --config ./harnessrouter.config.json --task-type coding --sort time
harnessrouter stats --config ./harnessrouter.config.json --task-type coding --sort tokens --json
```

`stats` reads saved runs. sorting does not change routing. see [performance](docs/PERFORMANCE.md).

### with your agent

after mcp is connected, ask things like:

- "use `list_harnesses`, then ask the best available worker to review this module. three findings, with file and line references. do not edit."
- "delegate this change to the opencode worker. return a patch limited to `src/router/`."
- "call `get_run` for the latest run and summarize status, artifacts, time, and tokens."

a read-only `route_task` looks like this. the route id is the profile id plus `:configured`.

```json
{
  "schemaVersion": "1.1",
  "taskId": "readme-review-001",
  "prompt": "Read README.md and name up to three concrete documentation gaps. Do not edit files.",
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

for an edit, use `requirements` `["coding"]`, `desiredOutput` `"patch"`, and `workspace.mode` `"patch"`. you review the patch before applying it. known secret names, `.git`, and dependency directories stay out of the snapshot. see [security](SECURITY.md) and [adapters](docs/ADAPTERS.md).

a source checkout can also turn on a pi browser route and a fal image route. they stay off until you opt in. [compatibility](docs/COMPATIBILITY.md).

## development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

tests use local fixtures. ci does not call a model. contributor notes: [contributing](CONTRIBUTING.md).

## links

- [issues](https://github.com/ozgureyilmaz/harnessrouter/issues)
- [mcp docs](https://modelcontextprotocol.io/docs)
- [architecture](docs/ARCHITECTURE.md)
- [compatibility](docs/COMPATIBILITY.md)
- [decision providers](docs/DECISION_PROVIDERS.md)
- [adapters](docs/ADAPTERS.md)
- [performance](docs/PERFORMANCE.md)
- [security and cost](docs/SECURITY_AND_COST.md)
- [security](SECURITY.md)
- [contributing](CONTRIBUTING.md)
- [deepwiki](https://deepwiki.com/ozgureyilmaz/harnessrouter)
