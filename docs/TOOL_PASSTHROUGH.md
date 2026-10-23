# Tool pass-through

A worker profile can hand a short allowlist of local MCP servers to Codex, Claude Code, or OpenCode. The default is nothing. An omitted `mcpServers` field and `"mcpServers": []` behave the same way.

## Opt in

```json
{
  "workerProfiles": [
    {
      "id": "codex-worker",
      "adapter": "codex",
      "model": "gpt-6-luna",
      "mcpServers": [
        {"name": "docs", "command": "/usr/bin/docs-mcp", "args": ["--stdio"]}
      ]
    }
  ]
}
```

Each entry is a stdio server: `name`, `command`, and optional `args`. A name starts with a lowercase letter and then uses lowercase letters, digits, or hyphens. The command is an executable name or an absolute path. There is no `env`, `url`, or `headers` field. At most four servers are accepted, and names must be unique.

The configured command runs with the worker. harnessrouter does not add another sandbox around that process. Leave the list empty unless the server is one you intend the worker to call.

## What each adapter receives

- Codex keeps `-c mcp_servers={}` until the list is set. An opt-in replaces that value with the named servers only. `features.multi_agent=false` stays set.
- Claude Code always keeps `harnessrouter_workspace`. An opt-in adds the named server beside it and extends `--allowedTools` with `mcp__<name>__*`. Native tools stay disabled.
- OpenCode keeps `mcp: {}` until the list is set. An opt-in writes `{type: "local", command, enabled: true}` for each named server. The other permission denials stay in place.
- Pi rejects a non-empty list at config load. Pi has no extra MCP servers in this release.

Names `harnessrouter` and `harnessrouter_workspace` are reserved. A command or argument whose path segment is `harnessrouter` is rejected, as is a shell command (`sh`, `bash`, `zsh`, `dash`, `fish`, `cmd`, `powershell`, `pwsh`). Values that look like `sk-…` or `Bearer …` are rejected and are not copied into the error text.

## Traces and listing

`worker.started` records `mcpServers` as names and command basenames. Arguments are omitted. `list_harnesses` returns `mcpAllowlists` with profile ids and server names. The trace redaction pass still applies to anything that reaches an event.

## No recursive delegation

A worker process has `HARNESSROUTER_WORKER=1`. `startServer` checks that variable before it connects stdio and refuses with `recursive_delegation_denied`. A nested harnessrouter that inherits the worker environment cannot serve. The config check also rejects a command or argument whose path segment is `harnessrouter`.
