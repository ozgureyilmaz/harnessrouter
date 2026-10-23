# Route profiles

A route profile is a named route on top of a worker profile. It chooses the harness, model, system instructions, workspace tools, MCP server names, and permission. The permission is `read-only` or `patch`.

Omit `routeProfiles` and the router keeps one route per worker, `workerId:configured`. Existing files behave as before. `preferredRouteId` can still pin that route.

```json
{
  "workerProfiles": [
    {"id": "codex-main", "adapter": "codex", "model": "gpt-5-codex", "enabled": true, "allowExecution": true, "allowUnknownCost": true}
  ],
  "routeProfiles": [
    {
      "id": "review",
      "harness": "codex-main",
      "permissions": "read-only",
      "systemInstructions": "Cite files and lines. Do not edit.",
      "enabledTools": ["list_files", "read_file"],
      "allowedMcpServers": []
    }
  ]
}
```

## Selection

`list_harnesses` returns a `profiles` array. Each entry has `id`, `routeId` (`harness:profile`), `permissions`, `enabledTools`, `allowedMcpServers`, and `mcpForwarded: false`.

The hosted decision model is offered profile routes instead of `workerId:configured` when that worker has any profile. `preferredRouteId` accepts the profile id (`review`) or the route id (`codex-main:review`). Pinning `codex-main:configured` still selects the original worker route.

Local priority uses the worker priority unless the profile sets `priority`. Equal top priorities defer to the host.

A read-only profile does not match a patch task. A patch profile can still run a read-only task without upgrading it to patch.

## What the worker receives

Profile instructions are trusted configuration. They are placed after the sandbox rules and cannot grant tools, permissions, or network access. A read-only profile forces the snapshot to read-only. A change to that snapshot fails the run.

`enabledTools` may only name `list_files`, `read_file`, and, for `patch`, `write_file`. The workspace MCP server lists and calls only that set. Codex, OpenCode, and Pi stay bounded by the read-only or patch sandbox. The tool name list does not remove their built-in editor when the permission is `patch`.

`allowedMcpServers` accepts up to eight local names. `harnessrouter` is rejected so a worker cannot be told to call this router. Names are shown in `list_harnesses` and in the run trace with `mcpForwarded: false`. They are not added to the worker MCP configuration. Codex keeps `mcp_servers={}`. Claude Code keeps only the bounded workspace server.

## Validation

Profile ids are unique, lowercase, and cannot be `configured`. `harness` must be an existing worker profile id. A model override must be that worker's model or one of its `allowedModels`. Unknown tools, duplicate names, and `write_file` on a read-only profile fail config load.
