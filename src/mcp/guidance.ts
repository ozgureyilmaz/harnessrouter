/** Short cookbook text shown to the host model. Detailed rules live in docs/HOST_GUIDANCE.md. */
export const MCP_INSTRUCTION_MAX = 600;
export const MCP_TOOL_DESCRIPTION_MAX = 240;

export const MCP_INSTRUCTIONS = [
  'Use route_task for one bounded task. An enabled local harness runs it in an isolated git snapshot and returns text or a patch. The patch is not applied to your repository.',
  'Delegate a review that should cite files. Delegate a small change that should come back as a patch. Do not delegate a question you can answer here. Do not delegate login, purchases, or private-account actions.',
  'Only profiles enabled in local config may run. A worker cannot call harnessrouter.',
].join('\n\n');

export const MCP_TOOL_DESCRIPTIONS = {
  route_task: 'Run one bounded task on an enabled harness. Returns text or a patch from an isolated snapshot. The patch is not applied. preferredRouteId skips selection. async:true returns running. A completed or failed taskId returns the saved result.',
  list_harnesses: 'List enabled harnesses, health, budget, and restrictions. Set includePerformance for local time and token stats. This makes no paid call.',
  get_run: 'Read a saved run by runId or taskId: result, route decision, and trace path. After a timeout, read the run before sending the task again.',
  cancel_run: 'Cancel local execution and request provider cancellation. A paid job already in progress may still bill. A cancelled taskId can run again.',
} as const;

export function hostGuidanceDocument(): string {
  return `# harnessrouter

harnessrouter is an MCP server in this project. It routes one bounded task to an enabled local harness. The harness runs in an isolated git snapshot and returns text or a patch. It does not edit this repository.

## When to call route_task

- Call it for a review that should cite files and lines.
- Call it for a small change that should come back as a patch to inspect.
- Do not call it for a question you can answer in this session.
- Do not call it for login, purchases, or private-account actions.

## Skill

When the user asks for another harness, an isolated run, or a reviewable patch:

1. Call \`list_harnesses\` before the first task.
2. Call \`route_task\` once. Set \`preferredRouteId\` only when the user named a harness.
3. If the call times out, call \`get_run\` with that \`runId\` or \`taskId\` before sending the task again. \`async: true\` returns a run id immediately.
4. Review a returned patch yourself. Do not treat it as already applied.

A worker cannot call harnessrouter. Roots, permissions, and models come from the local harnessrouter config, not from the task text.
`;
}

function assertGuidanceLimit(label: string, value: string, max: number): void {
  if (value.length > max) throw new Error(`${label} is ${value.length} characters; limit is ${max}`);
}

assertGuidanceLimit('MCP instructions', MCP_INSTRUCTIONS, MCP_INSTRUCTION_MAX);
for (const [name, description] of Object.entries(MCP_TOOL_DESCRIPTIONS)) {
  assertGuidanceLimit(`${name} description`, description, MCP_TOOL_DESCRIPTION_MAX);
}
