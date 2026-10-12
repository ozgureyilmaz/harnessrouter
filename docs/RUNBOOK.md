# Operator runbook — Mac + Codex

This is the post-build runbook. Older bootstrap instructions below are retained only where still useful; harnessrouter already has a local MCP server and both runtimes.

## Project location

Expected terminal context: `ozgur@air ~/dev/harnessrouter $`. Resolve using `cd ~/dev/harnessrouter && pwd` rather than assuming username/home absolute spelling. Prepare from within this directory.

## Check the current checkout and runtimes

```bash
cd ~/dev/harnessrouter
pwd
git status --short
node --version
npm --version
command -v pi && pi --help | head -40
command -v codex && codex mcp --help
```

The current checkout uses the maintained Pi package and its own restricted browser extension. Do not install the audited third-party `pi-browser-use` package for this demo.

## Optional official docs MCP in Codex

```bash
codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp
codex mcp list
```

Only adds docs server if wanted; its purpose is documentation search, not execution.

## Secrets

Store secrets only in untracked local environment or platform settings. Copy `config/.env.example` into an ignored env location **after** confirming repo `.gitignore` covers it. Load environment explicitly when running commands; a `cp` alone does not populate shell variables.

Do not pass secret values directly on a command line that may be logged. Never upload `.env` to repository.

## Local checks

```bash
npm run typecheck
npm test
npm run build
npm run demo:precheck
npm run eval:harnesses
npm run mcp:smoke
```

These checks are non-billable by default. Live fal/Pi integration tests require their explicit opt-in variables; never infer that a skipped live test passed.

## After rebuilding the local MCP server

```bash
npm run build
codex mcp get harnessrouter
```

The registered project server points at `dist/index.js`. A long-lived stdio process keeps the code loaded at startup; after a build, reload the harnessrouter MCP connection or reopen the Codex chat, then call `list_harnesses` and `get_run` to confirm current schema and budget. Local `npm run mcp:smoke` verifies the SDK bridge, not the active Codex process.

## Troubleshooting checklist

- Decisions API `401/403`: credentials, project enablement, access tier; do not silently mock as live.
- Decisions `400`: verify exact request structure from official docs and SDK version; log sanitized response.
- Decisions refused/invalid: safe defer/no-route, never execute an unoffered selection.
- Pi RPC hangs: ensure line-delimited framing, correlating command IDs, stdout reserved for protocol, timeout child process.
- Pi browser missing: extension loaded? compatible Node? Chrome installed? fresh browser mode works? Pi provider configured?
- fal job stuck: inspect queue state by request ID; avoid duplicate submission; bounded timeout; cancel only if supported.
- Image URL invalid: check response payload and content type, URL expiry, retry only within budget.
- MCP invisible in Codex: check registered server, project trust, session reload/restart, server stderr. Confirm in Codex MCP list.

## Source-of-truth for build

Read official docs linked in `docs/SOURCES_AND_ASSUMPTIONS.md`. Avoid copying stale examples if locally installed versions differ.
