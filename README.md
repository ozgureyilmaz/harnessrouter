# harnessrouter

task-aware execution across independent agent harnesses through MCP.

harnessrouter explores how a single Codex session can route coding-agent tasks to independent harnesses and receive inspectable results. The host keeps the task context; each harness owns its execution tools, constraints, recovery, and artifacts.

**Status: under development.** The full project is not yet complete. Setup instructions, verified demos, and detailed documentation will follow after the build.

## why harnessrouter

Coding agents handle implementation, debugging, testing, research, automation, and many other kinds of work. Different tasks can benefit from different tools, models, context strategies, and execution environments.

harnessrouter aims to let the host choose an appropriate harness for each task while keeping one continuous session. The design supports adding new harnesses as needs change, with explicit permissions, budgets, and result verification across handoffs.

The intended flow:

```text
task / Codex session
        ↓
local MCP gateway
        ↓
permission, capability, and budget checks
        ↓
Decisions API: choose an eligible route
        ↓
independent harness execution
        ↓
result verification + artifacts + traces
        ↓
return to Codex
```

## approach

- **Task-aware routing:** select from reachable, authorized harness and model configurations.
- **Independent execution:** each harness runs its own task lifecycle behind a shared MCP interface.
- **Composition:** use one harness's findings or artifacts as input to another task.
- **Explicit outcomes:** return inspectable results, failures, or a handoff back to the host.

Cross-harness interoperability is the first target. Improvements in task success, speed, or cost remain hypotheses to test.
