# Host guidance

The MCP `instructions` string and tool descriptions are a short cookbook. A host model may skip them. This page keeps the rules that used to live only in that string.

`harnessrouter init` writes `AGENTS.md` in the current directory when the file is absent. The file tells a host agent when to call `route_task` and includes a short skill. If `AGENTS.md` already exists, an interactive terminal asks before replacing it. A non-interactive run leaves the file unchanged and prints the snippet.

## When to delegate

- A review that should cite files and lines.
- A small change that should come back as a patch to inspect.
- Work that should run on a harness other than the current host session.

## When not to delegate

- A question the host session can answer itself.
- A `taskId` that already completed or failed. Read that result instead of starting another paid run.
- Login, purchases, or private-account actions.

## Rules

These statements stay in force. The short MCP text keeps the ones a host must see before the first call. The rest are here so the tool list stays short.

- Delegate one bounded task per `route_task` from the current host.
- Only explicitly enabled local worker profiles may execute repository work, in isolated snapshots returning patches.
- Workspace roots, permissions and model configuration come from trusted local configuration.
- A new init file uses local priority and needs no decision API key.
- OpenAI Decisions, Jev, or loopback Ollaya run only when selector is decisions; a config that omits selector still uses OpenAI Decisions.
- Eligibility and authorization always precede selection.
- Use preferredRouteId to choose a worker without a decision call; deterministic local priority ties defer to the host.
- Subscription-backed workers require allowUnknownCost:true.
- Pi browser remains public/read-only and fal supports images only.
- Image generation requires explicit paid approval.
- Inspect get_run after timeout and reuse taskId to reconcile; never duplicate an ambiguous paid job.
- Workers cannot recursively delegate.
- No login, purchases or private-account actions.

Browser tasks still pass `context.url` plus `allowedDomains`. Image tasks still pass `context.creativeOptions`. A synchronous `route_task` sends progress notifications when the host provides a progress token. `async: true` returns `{runId, taskId, status: "running"}` and keeps running if that request is cancelled. `get_run` accepts `runId` or `taskId`. A cancelled or interrupted taskId can be submitted again. A completed or failed taskId returns the saved result.

A returned patch is for review. harnessrouter does not apply it to the source repository.
