import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {getEligibleRoutes} from '../../src/registry/eligibility.js';
import {selectLocal} from '../../src/routing/local.js';
import {workerManifests} from '../../src/workers/registry.js';
import {ProcessWorkerAdapter} from '../../src/workers/adapter.js';
import {workspaceTool} from '../../src/workers/fs-mcp.js';
import {claudeCodeWorker} from '../../src/workers/claude-code.js';
import {codexWorker} from '../../src/workers/codex.js';
import {runProcess, workerEnvironment} from '../../src/workers/process.js';
import type {DecisionSelector} from '../../src/routing/decision-provider.js';
import type {HarnessTask} from '../../src/domain/types.js';
import type {RouteProfile} from '../../src/workers/route-profile.js';
import type {WorkerProfile, WorkerProtocol} from '../../src/workers/types.js';

const worker: WorkerProfile = {id: 'codex-main', adapter: 'codex', model: 'fixture-model', enabled: true, allowExecution: true, allowUnknownCost: true, allowedModels: ['fixture-alt']};
const review: RouteProfile = {id: 'review', harness: 'codex-main', permissions: 'read-only', systemInstructions: 'Cite files only.', enabledTools: ['read_file'], allowedMcpServers: ['docs']};
const task = (partial: Partial<HarnessTask> = {}): HarnessTask => ({schemaVersion: '1.1', taskId: 'profile-task', prompt: 'Review greeting', requirements: ['review'], acceptanceCriteria: [], desiredOutput: 'text', workspace: {root: '/project', mode: 'read-only'}, allowUnknownCost: true, ...partial});

async function tempConfig(body: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'hr-profile-config-'));
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(body));
  return {root, path, env: {XDG_CONFIG_HOME: join(root, 'unused')}};
}

test('configs without route profiles keep a single configured route', async () => {
  const dir = await tempConfig({selector: 'local', workerProfiles: [worker]});
  try {
    const config = loadConfig({cwd: dir.root, configPath: dir.path, env: dir.env});
    assert.deepEqual(config.routeProfiles, []);
    assert.equal(workerManifests(config.workerProfiles ?? [])[0]?.routes.length, 1);
    assert.equal(workerManifests(config.workerProfiles ?? [])[0]?.routes[0]?.id, 'codex-main:configured');
  } finally { await rm(dir.root, {recursive: true, force: true}); }
});

test('route profile config rejects widened permissions, recursive servers, and unknown models', async () => {
  const cases = [
    [{...review, enabledTools: ['write_file']}, /write_file/],
    [{...review, allowedMcpServers: ['harnessrouter']}, /recursive/],
    [{...review, harness: 'missing'}, /configured worker/],
    [{...review, model: 'other-model'}, /allowlist/],
    [{...review, id: 'configured'}, /configured/],
  ] as const;
  for (const [profile, pattern] of cases) {
    const dir = await tempConfig({workerProfiles: [worker], routeProfiles: [profile]});
    try { assert.throws(() => loadConfig({cwd: dir.root, configPath: dir.path, env: dir.env}), pattern); }
    finally { await rm(dir.root, {recursive: true, force: true}); }
  }
});

test('selection offers profiles and a read-only profile cannot satisfy a patch', () => {
  const edit: RouteProfile = {id: 'edit', harness: 'codex-main', permissions: 'patch', allowedMcpServers: [], priority: 5};
  const registry = {version: 1 as const, harnesses: workerManifests([worker], [review, edit])};
  const policy = {selector: 'local' as const, allowPaid: false, dryRun: false, allowExecution: true, workerProfiles: [worker], routeProfiles: [review, edit], allowedDomains: [], remainingBudgetUsd: 0, credentials: {openai: false, fal: false}};
  const health = {[worker.id]: {available: true}};
  const text = getEligibleRoutes(task(), registry, health, policy);
  assert.deepEqual(text.eligible.map(item => item.route.id).sort(), ['codex-main:edit', 'codex-main:review']);
  assert.equal(selectLocal(text.eligible, [worker], [review, edit])?.route.id, 'codex-main:edit');
  const pinned = getEligibleRoutes(task({preferredRouteId: 'review'}), registry, health, policy);
  assert.deepEqual(pinned.eligible.map(item => item.route.id), ['codex-main:review']);
  const patch = getEligibleRoutes(task({desiredOutput: 'patch', workspace: {root: '/project', mode: 'patch'}, requirements: ['coding']}), registry, health, policy);
  assert.deepEqual(patch.eligible.map(item => item.route.id), ['codex-main:edit']);
  const legacy = getEligibleRoutes(task({preferredRouteId: 'codex-main:configured', desiredOutput: 'patch', workspace: {root: '/project', mode: 'patch'}, requirements: ['coding']}), registry, health, policy);
  assert.deepEqual(legacy.eligible.map(item => item.route.id), ['codex-main:configured']);
});

test('hosted selection is offered profile routes and list_harnesses does not forward MCP servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-profile-route-'));
  const other: WorkerProfile = {...worker, id: 'claude-main', adapter: 'claude-code'};
  const second: RouteProfile = {id: 'notes', harness: 'claude-main', permissions: 'read-only', allowedMcpServers: [], systemInstructions: 'Explain only.'};
  try {
    const config = loadConfig({cwd: root, env: {XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), ROUTER_DECISION_PROVIDER: 'ollaya', MAX_COST_USD_PER_TASK: '0'}});
    Object.assign(config, {dryRun: false, allowPaid: false, allowExecution: true, selector: 'decisions', workerProfiles: [worker, other], routeProfiles: [review, second], workspaceRoots: [root], artifactsDir: join(root, 'runs')});
    const ledger = await BudgetLedger.open(config.artifactsDir, 0);
    const offered: string[][] = [];
    const selector: DecisionSelector = {provider: 'ollaya', requiresPaid: false, reservationUsd: 0, async choose(_task, choices) {
      offered.push(choices.map(choice => `${choice.value}|${choice.description}`));
      return {routeId: 'codex-main:review', model: 'fixture', latencyMs: 1, cost: {status: 'not_applicable', usd: 0}, providerDecisionId: 'fixture'};
    }};
    let ran = '';
    const adapters = [worker, other].map(profile => ({id: profile.id, async health() { return {available: true, modelId: profile.model}; }, async execute(_task: HarnessTask, context: {artifactsDir: string}) {
      ran = profile.id;
      const path = join(context.artifactsDir, 'answer.txt');
      await writeFile(path, 'offline');
      return {status: 'completed' as const, summary: 'offline', artifacts: [{type: 'text' as const, path, verified: false}], cost: {status: 'unknown' as const}};
    }}));
    const router = new HarnessRouter(config, adapters, ledger, selector);
    try {
      const listing = await router.listHarnesses();
      assert.equal(listing.profiles.length, 2);
      assert.equal(listing.profiles.every(profile => profile.mcpForwarded === false), true);
      assert.equal(listing.profiles.find(profile => profile.id === 'review')?.routeId, 'codex-main:review');
      const result = await router.routeTask(task({workspace: {root, mode: 'read-only'}}));
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.equal(result.selectedRouteId, 'codex-main:review');
      assert.equal(ran, 'codex-main');
      assert.equal(offered.length, 1);
      assert.deepEqual(offered[0]?.map(item => item.split('|')[0]).sort(), ['claude-main:notes', 'codex-main:review']);
      assert.match(offered[0]?.find(item => item.startsWith('codex-main:review')) ?? '', /read-only/);
      assert.doesNotMatch(offered.join('\n'), /codex-main:configured/);
    } finally { await router.close(); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a read-only profile forces a read-only snapshot and does not forward MCP servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-profile-run-'));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) => runProcess('git', args, {cwd: source, env: workerEnvironment(), timeoutMs: 5000});
  await git(['init', '-q']);
  await writeFile(join(source, 'greeting.txt'), 'original\n');
  await git(['add', 'greeting.txt']);
  await git(['-c', 'user.name=fixture', '-c', 'user.email=f@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const seen: {mode?: string; prompt?: string; tools?: readonly string[]} = {};
  const protocol: WorkerProtocol = {kind: 'codex', requiredHelpFlags: [], async probe() { return {available: true}; }, async invocation(_profile, options) {
    seen.mode = options.mode; seen.prompt = options.prompt; seen.tools = options.enabledTools;
    return {command: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({type:'done',text:'original'})+'\\n')"], stdin: ''};
  }, parse(records) { return {text: String(records[0]?.text ?? ''), cost: {status: 'unknown'}}; }};
  try {
    const config = {...loadConfig({cwd: root, env: {XDG_CONFIG_HOME: join(root, 'user')}}), selector: 'local' as const, allowPaid: false, dryRun: false, allowExecution: true, workerProfiles: [worker], routeProfiles: [review], workspaceRoots: [source], artifactsDir: join(root, 'runs')};
    const ledger = await BudgetLedger.open(config.artifactsDir, 0);
    const router = new HarnessRouter(config, [new ProcessWorkerAdapter(worker, protocol, {roots: [source]}, config.artifactsDir, true)], ledger);
    try {
      const result = await router.routeTask(task({workspace: {root: source, mode: 'patch'}, preferredRouteId: 'review'}));
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.equal(result.selectedRouteId, 'codex-main:review');
      assert.equal(seen.mode, 'read-only');
      assert.match(seen.prompt ?? '', /Cite files only/);
      assert.match(seen.prompt ?? '', /not forwarded/);
      assert.deepEqual(seen.tools, ['read_file']);
      assert.equal(await readFile(join(source, 'greeting.txt'), 'utf8'), 'original\n');
      const trace = await readFile(result.tracePath!, 'utf8');
      assert.match(trace, /"mcpForwarded":false/);
      assert.doesNotMatch(trace, /https?:\/\//);
    } finally { await router.close(); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('workspace tools and Claude MCP stay inside the profile allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-profile-tools-'));
  try {
    await writeFile(join(root, 'greeting.txt'), 'hello');
    await assert.rejects(workspaceTool(root, 'patch', 'write_file', {path: 'greeting.txt', content: 'x'}, ['read_file']), /did not enable/);
    assert.deepEqual(await workspaceTool(root, 'read-only', 'read_file', {path: 'greeting.txt'}, ['read_file']), {path: 'greeting.txt', content: 'hello'});
    const invocation = await claudeCodeWorker.invocation({...worker, adapter: 'claude-code'}, {cwd: root, prompt: 'read', mode: 'read-only', runDirectory: root, enabledTools: ['read_file']});
    const mcp = JSON.parse(await readFile(join(root, 'claude-mcp.json'), 'utf8')) as {mcpServers: Record<string, {args: string[]}>};
    assert.deepEqual(Object.keys(mcp.mcpServers), ['harnessrouter_workspace']);
    assert.equal(mcp.mcpServers.harnessrouter_workspace.args.at(-1), 'read_file');
    assert.match(invocation.args.join('\n'), /mcp__harnessrouter_workspace__read_file/);
    assert.doesNotMatch(invocation.args.join('\n'), /mcp__harnessrouter_workspace__\*/);
    const codex = await codexWorker.invocation(worker, {cwd: root, prompt: 'read', mode: 'read-only', runDirectory: root});
    assert.ok(codex.args.includes('mcp_servers={}'), codex.args.join(' '));
  } finally { await rm(root, {recursive: true, force: true}); }
});
