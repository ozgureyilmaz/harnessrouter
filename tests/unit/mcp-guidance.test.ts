import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {PROJECT_ROOT} from '../../src/config.js';
import {MCP_INSTRUCTION_MAX, MCP_INSTRUCTIONS, MCP_TOOL_DESCRIPTION_MAX, MCP_TOOL_DESCRIPTIONS, hostGuidanceDocument} from '../../src/mcp/guidance.js';
import {createMcpServer} from '../../src/mcp/tools.js';
import type {HarnessRouter} from '../../src/runner.js';

const KEPT_RULES = [
  'Delegate one bounded task per `route_task` from the current host.',
  'Only explicitly enabled local worker profiles may execute repository work, in isolated snapshots returning patches.',
  'Workspace roots, permissions and model configuration come from trusted local configuration.',
  'A new init file uses local priority and needs no decision API key.',
  'OpenAI Decisions, Jev, or loopback Ollaya run only when selector is decisions; a config that omits selector still uses OpenAI Decisions.',
  'Eligibility and authorization always precede selection.',
  'Use preferredRouteId to choose a worker without a decision call; deterministic local priority ties defer to the host.',
  'Subscription-backed workers require allowUnknownCost:true.',
  'Pi browser remains public/read-only and fal supports images only.',
  'Image generation requires explicit paid approval.',
  'Inspect get_run after timeout and reuse taskId to reconcile; never duplicate an ambiguous paid job.',
  'Workers cannot recursively delegate.',
  'No login, purchases or private-account actions.',
];

test('MCP cookbook text stays short and names when to delegate', () => {
  assert.ok(MCP_INSTRUCTION_MAX <= 800);
  assert.ok(MCP_TOOL_DESCRIPTION_MAX <= 320);
  assert.ok(MCP_INSTRUCTIONS.length <= MCP_INSTRUCTION_MAX);
  assert.ok(MCP_INSTRUCTIONS.length > 0);
  for (const description of Object.values(MCP_TOOL_DESCRIPTIONS)) {
    assert.ok(description.length <= MCP_TOOL_DESCRIPTION_MAX);
    assert.ok(description.length > 0);
  }
  assert.match(MCP_INSTRUCTIONS, /Delegate a review/);
  assert.match(MCP_INSTRUCTIONS, /Delegate a small change/);
  assert.match(MCP_INSTRUCTIONS, /Do not delegate a question/);
  assert.match(MCP_INSTRUCTIONS, /Do not delegate login, purchases, or private-account actions/);
  assert.match(MCP_INSTRUCTIONS, /isolated git snapshot/);
  assert.match(MCP_INSTRUCTIONS, /not applied/);
  assert.match(MCP_INSTRUCTIONS, /cannot call harnessrouter/);
  assert.match(MCP_TOOL_DESCRIPTIONS.route_task, /not applied/);
  assert.match(MCP_TOOL_DESCRIPTIONS.get_run, /timeout/);
  assert.match(MCP_TOOL_DESCRIPTIONS.cancel_run, /may still bill/);
  assert.match(MCP_TOOL_DESCRIPTIONS.list_harnesses, /no paid call/i);
  const snippet = hostGuidanceDocument();
  assert.match(snippet, /route_task/);
  assert.match(snippet, /Do not call it for login/);
  assert.match(snippet, /## Skill/);
});

test('host guidance doc keeps the safety rules removed from the tool list', async () => {
  const doc = await readFile(join(PROJECT_ROOT, 'docs/HOST_GUIDANCE.md'), 'utf8');
  for (const rule of KEPT_RULES) assert.ok(doc.includes(rule), rule);
});

test('listed MCP tools use the short descriptions and instructions', async () => {
  const server = createMcpServer({} as HarnessRouter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({name: 'guidance-test', version: '0'});
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map(tool => [tool.name, tool.description]));
  assert.deepEqual([...byName.keys()].sort(), ['cancel_run', 'get_run', 'list_harnesses', 'route_task']);
  for (const [name, description] of Object.entries(MCP_TOOL_DESCRIPTIONS)) {
    assert.equal(byName.get(name), description);
  }
  const instructions = client.getInstructions();
  assert.equal(instructions, MCP_INSTRUCTIONS);
  await client.close();
  await server.close();
});
