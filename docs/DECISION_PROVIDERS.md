# Decision providers

harnessrouter can ask a decision provider to choose among routes that already passed local eligibility and authorization checks. The provider never creates a route or changes the worker model. It runs only when `selector` is `decisions`. A new `harnessrouter init` file sets `selector` to `local`, so the first run uses configured priority and does not need an API key. Dry run stays on, worker execution stays off, and paid calls stay off until you change them.

## First-run and omitted selector

`harnessrouter init` writes `"selector": "local"` and does not write decision-provider fields. Routing then uses configured worker priority, or an explicit `preferredRouteId`. Equal top priorities defer to the host instead of guessing. No decision provider is called.

Opt in when you create the file:

```bash
harnessrouter init --selector decisions --decision-provider openai --config ./harnessrouter.config.json
harnessrouter init --selector decisions --decision-provider jev --config ./harnessrouter.config.json
harnessrouter init --selector decisions --decision-provider ollaya --config ./harnessrouter.local.json
```

`--decision-provider` without `--selector` also selects `decisions`. `--selector local` together with `--decision-provider` is an error. The provider names are `openai`, `jev`, and `ollaya`. When you opt in and omit the provider, the starter uses OpenAI.

A configuration file that omits `selector`, and a process with no configuration file, still resolve to `decisions` with OpenAI (`gpt-6-luna`). That preserves files written before this change, and any file that relied on the implicit default. It stays fail-closed: hosted selection does not run without its key, paid authorization, and execution permission. To move such a file onto the keyless path, set `"selector": "local"` or `ROUTER_SELECTOR=local`. An explicit `"selector": "decisions"` already stored by an older `init` is unchanged.

`ROUTER_SELECTOR` overrides the file. The decision-provider lines in `config/.env.example` stay commented until you uncomment them.

## Choose a provider

| Provider | Decision model | Credential and endpoint |
| --- | --- | --- |
| OpenAI Decisions | `gpt-6-luna` | Default provider when `selector` is `decisions` and `decisionProvider` is omitted. `OPENAI_API_KEY`; OpenAI's dedicated Decisions API. The current API documentation lists `gpt-6-luna` as the supported Decisions model. |
| TypeSafe JEV | `jev-latest` by default; model must use `jev-*` | `TYPESAFE_API_KEY`, or `JEV_API_KEY` as a compatibility alias. The alias and primary key must match if both are set. |
| Ollaya System One (local) | `laya:typed-decisions` by default; choose a local model name explicitly | Defaults to `http://127.0.0.1:11435`. Override with `ROUTER_OLLAYA_BASE_URL` or `ollayaBaseUrl` using one of the supported loopback hosts: `localhost`, `127.0.0.1`, or `[::1]`. Remote URLs, other loopback IPs, paths, queries, fragments, and embedded credentials are rejected. `OLLAYA_API_KEY` is optional. |

OpenAI's Decisions API uses its own request schema and pinned model. TypeSafe has a separate typed decision API. Ollaya documents a TypeSafe-compatible System One wire format where `POST /v1/decisions` aliases `POST /v1/systemone`; that route is not an OpenAI endpoint. See the [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [TypeSafe API reference](https://docs.typesafe.ai/api), and [Ollaya TypeSafe compatibility documentation](https://ollaya.dev/docs/typesafe-compatibility).

## Configure

Provider choices and non-secret settings can also be set in the JSON configuration after you opt in:

```json
{
  "selector": "decisions",
  "decisionProvider": "jev",
  "decisionModel": "jev-latest",
  "decisionTimeoutMs": 10000,
  "decisionReserveUsd": 0.01
}
```

Environment overrides are `ROUTER_SELECTOR`, `ROUTER_DECISION_PROVIDER`, `DECISIONS_MODEL`, `ROUTER_DECISION_RESERVE_USD`, and `ROUTER_OLLAYA_BASE_URL`. Credentials stay in the process environment or an ignored local `.env`; credential fields are not accepted in JSON configuration. Use the provider-specific key shown above. harnessrouter does not reuse `OPENAI_API_KEY` for TypeSafe or Ollaya.

### Enable hosted selection

For OpenAI, set `OPENAI_API_KEY` in the environment and use this JSON configuration:

```json
{
  "selector": "decisions",
  "decisionProvider": "openai",
  "decisionModel": "gpt-6-luna",
  "dryRun": false,
  "allowPaid": true,
  "allowExecution": true,
  "perTaskUsd": 0.25,
  "sessionUsd": 2,
  "decisionReserveUsd": 0.01
}
```

For TypeSafe JEV, set `TYPESAFE_API_KEY` (or `JEV_API_KEY`) and change `decisionProvider` to `jev` and `decisionModel` to `jev-latest`. The paid-call gates and finite budget fields are the same. These settings enable the selection step only; separately configure eligible worker profiles and authorize each task's requested workspace and execution mode. Native-worker unknown costs still require the task's explicit `allowUnknownCost` authorization.

### Enable local Ollaya selection

Ollaya does not use a hosted paid reservation. Configure its explicit local model and loopback base URL, and leave paid authorization disabled:

```json
{
  "selector": "decisions",
  "decisionProvider": "ollaya",
  "decisionModel": "laya:typed-decisions",
  "ollayaBaseUrl": "http://127.0.0.1:11435",
  "dryRun": false,
  "allowPaid": false,
  "allowExecution": true,
  "perTaskUsd": 0,
  "sessionUsd": 0,
  "decisionReserveUsd": 0
}
```

Set `OLLAYA_API_KEY` only if your local service requires it. `doctor` reports this configuration as valid while stating that live endpoint availability is unverified. Enabling Ollaya selection does not enable worker execution; configure worker profiles and issue separate task-level authorization for any route that should run.

OpenAI and hosted TypeSafe clients keep a positive finite `ROUTER_DECISION_RESERVE_USD` configured (USD 0.01 by default), including while `selector: "local"` is selected or the task cap is zero, because the router constructs the selected client at startup. No reservation is made unless a paid selection runs. The reserve must be no greater than `MAX_COST_USD_PER_TASK` only when hosted selection is enabled with a positive task cap. `decisionTimeoutMs` must be a positive integer no greater than `2,147,483,647`. Local Ollaya uses a zero paid reservation.

`selector: "local"` applies configured priority or an explicit `preferredRouteId` and does not call a provider. Set it in trusted JSON or with `ROUTER_SELECTOR=local`. There is no implicit provider fallback: a missing key, invalid response, or provider failure remains an explicit failure or host-defer result. Switching a file from `local` to `decisions` does not grant paid calls or execution; those gates stay closed until you open them.

## Chat workflow

Merge your provider settings into the [worker configuration](../README.md#setup). Enable profiles with explicit models supported by their installed runtimes and grant the project root. To exercise model-based selection for a review, configure at least two eligible review workers. A single eligible route or an explicit `preferredRouteId` skips inference; this avoids unnecessary selection latency and hosted charges.

Execution permission and workspace preflight come before selector payment admission. A sole worker or pinned image profile uses its full execution budget without a decision reservation. Underlying permissions still apply: native workers need their explicit unknown-cost grants, Pi always needs global execution and task unknown-cost grants, and image generation needs its own paid authorization. A paid choice among multiple routes must fit the selection reserve as well as execution costs before any request is sent.

For Ollaya, start the real local server and pull the configured model before routing. The default model is `laya:typed-decisions` and the default endpoint is `POST http://127.0.0.1:11435/v1/systemone`:

```bash
ollaya serve
ollaya pull laya:typed-decisions
```

`ollaya list` shows installed model names. harnessrouter does not start the service or download models. A missing model fails with `decision_model_unavailable` and the server's short error text. Other HTTP errors keep their status code and a sanitized provider message. The request is not retried and the provider is not swapped. Local inference has no hosted fee, but native workers can still consume subscription or API usage.

Hosted selection sends the task text plus one description per eligible route. The built-in descriptions distinguish a read-only review from a patch, which is what lets a local decision model choose different harnesses. Set `description` on a worker profile to replace that sentence.

Reload your host's MCP connection after rebuilding or changing configuration. In Codex, Claude Code, OpenCode, or Pi, ask:

> Inspect harnessrouter's available workers and decision provider. Use its configured decision model to choose an eligible worker to review README.md in /absolute/path/to/project. Return up to three concrete documentation gaps. Do not edit files. I authorize the configured worker's unknown per-run usage for this read-only task.

The host should inspect `list_harnesses` and submit `route_task` without pinning a worker:

```json
{
  "schemaVersion": "1.1",
  "taskId": "decision-review-001",
  "prompt": "Review README.md and report up to three concrete documentation gaps. Do not edit files.",
  "requirements": ["review"],
  "acceptanceCriteria": [],
  "desiredOutput": "text",
  "allowUnknownCost": true,
  "workspace": {"root": "/absolute/path/to/project", "mode": "read-only"}
}
```

Use a fresh task ID for different work. The router filters routes, preflights the workspace, asks the configured provider only when a choice is needed, rechecks the chosen runtime, executes the bounded worker and returns verified artifacts. Inspect `get_run` using the returned run ID for provider/model, eligible IDs, decision latency and usage. Confidence is model metadata, not a calibrated success probability. A trace or completed artifact alone does not establish superior output quality.

## Safety and doctor

The starter configuration keeps `dryRun` true, `allowPaid` false, and `allowExecution` false (`ROUTER_DRY_RUN`, `ROUTER_ALLOW_PAID_RUNS`, and `ROUTER_ALLOW_EXECUTION`). A fresh local starter makes `doctor` report the decision layer as disabled, because the provider configuration is unused. A configured provider is not contacted until `selector` is `decisions` and the required live settings and task eligibility allow a decision. `doctor` displays the selected provider/model and credential presence; it makes no connectivity, authentication, or inference request. For Ollaya it reports the configured loopback URL while marking live availability unverified.
