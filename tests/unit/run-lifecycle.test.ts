import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, utimes, writeFile, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {HarnessRouter} from '../../src/runner.js';
import {loadConfig} from '../../src/config.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {createMcpServer} from '../../src/mcp/tools.js';
import {ProcessWorkerAdapter} from '../../src/workers/adapter.js';
import {workerManifests} from '../../src/workers/registry.js';
import {runProcess, workerEnvironment} from '../../src/workers/process.js';
import {acquireWorkerLease, currentProcessIdentity, reconcileLeases} from '../../src/workers/lease.js';
import {parseAge, pruneRuns} from '../../src/workers/prune.js';
import {runCli} from '../../src/cli.js';
import type {HarnessTask} from '../../src/domain/types.js';
import type {WorkerProfile, WorkerProtocol} from '../../src/workers/types.js';

const imageTask: HarnessTask = {
  schemaVersion: '1.0', taskId: 'lifecycle', prompt: 'Create a simple test illustration',
  requirements: ['text_to_image', 'image'], desiredOutput: 'image', allowPaidExecution: true,
  acceptanceCriteria: ['Image decodes'],
};

async function imageRouter(delayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), 'hr-lifecycle-'));
  const config = {...loadConfig({cwd: root, env: {XDG_CONFIG_HOME: join(root, 'config')}}), selector: 'decisions' as const, allowPaid: true, dryRun: false, apiKey: undefined, falKey: 'unit-test-only', imageRoute: 'fast' as const, artifactsDir: root, progressIntervalMs: 30};
  let calls = 0;
  const adapter = {
    id: 'fal-creative',
    health: async () => ({available: true}),
    execute: async (_task: HarnessTask, ctx: {artifactsDir: string; signal: AbortSignal}) => {
      calls += 1;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      ctx.signal.throwIfAborted();
      const path = join(ctx.artifactsDir, 'mock-unit-image.png');
      await sharp({create: {width: 64, height: 64, channels: 3, background: '#444'}}).png().toFile(path);
      return {status: 'completed' as const, summary: 'Offline mock artifact', artifacts: [{type: 'image' as const, path, verified: false, providerRequestId: 'fal-test-request'}], cost: {status: 'estimated' as const, usd: .003, details: 'Fixture published-rate estimate'}, usage: [], costComponents: []};
    },
  };
  const ledger = await BudgetLedger.open(root, 5);
  const router = new HarnessRouter(config, [adapter], ledger);
  return {router, root, get calls() {return calls;}, async close() {await router.close(); await rm(root, {recursive: true, force: true});}};
}

test('progress notifications continue a route_task past a short host timeout', async () => {
  const fixture = await imageRouter(400);
  try {
    const server = createMcpServer(fixture.router);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({name: 'lifecycle-test', version: '0'});
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.equal(listed.tools.find(tool => tool.name === 'route_task')?.outputSchema?.type, 'object');
    const notes: string[] = [];
    const result = await client.callTool({name: 'route_task', arguments: {...imageTask, taskId: 'progress-run', acceptanceCriteria: ['Image decodes']}}, undefined, {
      timeout: 120,
      resetTimeoutOnProgress: true,
      onprogress: progress => {if (progress.message) notes.push(progress.message);},
    });
    assert.equal(result.isError, false);
    const body = JSON.parse((result.content as {text: string}[])[0].text) as {status: string};
    assert.equal(body.status, 'completed');
    assert.ok(notes.length >= 1, 'expected progress notifications');
    assert.ok(notes.some(note => /^(validating|selecting|executing|collecting) elapsedMs=\d+$/.test(note)), notes.join('\n'));
    await client.close();
    await server.close();
  } finally {await fixture.close();}
});

test('async route_task returns immediately and get_run by taskId observes completion', async () => {
  const fixture = await imageRouter(250);
  try {
    const controller = new AbortController();
    const started = Date.now();
    const ack = await fixture.router.routeTask({...imageTask, taskId: 'async-run', async: true}, controller.signal);
    controller.abort();
    assert.equal(ack.status, 'running');
    assert.equal(ack.taskId, 'async-run');
    assert.match(ack.runId, /^[0-9a-f-]{36}$/);
    assert.ok(Date.now() - started < 150, `async acknowledgement took ${Date.now() - started}ms`);
    const deadline = Date.now() + 3000;
    let status = '';
    while (Date.now() < deadline) {
      const saved = await fixture.router.getRun({taskId: 'async-run'});
      status = (saved.result as {status?: string} | null)?.status ?? '';
      if (status === 'completed') {
        assert.equal((saved.result as {runId: string}).runId, ack.runId);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status, 'completed');
    const server = createMcpServer(fixture.router);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({name: 'lifecycle-async', version: '0'});
    await client.connect(clientTransport);
    await client.listTools();
    const mcpAck = await client.callTool({name: 'route_task', arguments: {...imageTask, taskId: 'async-mcp', async: true}});
    const ackBody = JSON.parse((mcpAck.content as {text: string}[])[0].text) as {status: string; taskId: string};
    assert.equal(mcpAck.isError, false);
    assert.equal(ackBody.status, 'running');
    assert.equal(ackBody.taskId, 'async-mcp');
    await client.close();
    await server.close();
  } finally {await fixture.close();}
});

test('cancelled task ids can run again and completed task ids stay idempotent', async () => {
  const fixture = await imageRouter(0);
  try {
    const controller = new AbortController();
    controller.abort();
    const task = {...imageTask, taskId: 'retry-me', acceptanceCriteria: ['Image decodes']};
    const cancelled = await fixture.router.routeTask(task, controller.signal);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error?.code, 'client_disconnected');
    const again = await fixture.router.routeTask(task);
    assert.equal(again.status, 'completed');
    assert.notEqual(again.runId, cancelled.runId);
    assert.equal(fixture.calls, 1);
    const history = await fixture.router.getRun(cancelled.runId);
    assert.equal((history.result as {status: string}).status, 'cancelled');
    const latest = await fixture.router.getRun({taskId: 'retry-me'});
    assert.equal((latest.result as {runId: string}).runId, again.runId);
    const replay = await fixture.router.routeTask(task);
    assert.equal(replay.runId, again.runId);
    assert.equal(fixture.calls, 1);
  } finally {await fixture.close();}
});

test('reconcile interrupts a dead lease, leaves a live lease busy, and clears a stale executing run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-reconcile-'));
  try {
    const runId = randomUUID();
    const runDirectory = join(root, runId);
    await mkdir(join(runDirectory, 'workspace'), {recursive: true});
    await writeFile(join(runDirectory, 'workspace', 'leftover.txt'), 'snapshot');
    await writeFile(join(runDirectory, 'status.json'), JSON.stringify({runId, status: 'executing'}) + '\n');
    await writeFile(join(runDirectory, 'task.json'), JSON.stringify({taskId: 'stuck-task'}) + '\n');
    await writeFile(join(runDirectory, 'events.jsonl'), '');
    const deadProfile = 'dead-worker';
    const leaseDir = join(root, 'worker-leases');
    await mkdir(leaseDir, {recursive: true});
    const {createHash} = await import('node:crypto');
    const deadPath = join(leaseDir, `${createHash('sha256').update(deadProfile).digest('hex')}.json`);
    await writeFile(deadPath, JSON.stringify({profileId: deadProfile, runId, pid: 987654321, token: 'dead', startedAt: '2020-01-01T00:00:00.000Z', hostname: currentProcessIdentity().hostname, processStartedAt: '2020-01-01T00:00:00.000Z'}));
    const changes = await reconcileLeases(root);
    assert.equal(changes[0]?.action, 'interrupted');
    assert.equal(JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8')).status, 'interrupted');
    assert.equal(JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8')).status, 'interrupted');
    assert.match(await readFile(join(runDirectory, 'events.jsonl'), 'utf8'), /run\.interrupted/);
    await assert.rejects(lstat(deadPath), {code: 'ENOENT'});
    await assert.rejects(lstat(join(runDirectory, 'workspace')), {code: 'ENOENT'});

    const liveRun = randomUUID();
    const liveDirectory = join(root, liveRun);
    await mkdir(liveDirectory, {recursive: true});
    await writeFile(join(liveDirectory, 'status.json'), JSON.stringify({runId: liveRun, status: 'executing'}) + '\n');
    const liveProfile = 'live-worker';
    const livePath = join(leaseDir, `${createHash('sha256').update(liveProfile).digest('hex')}.json`);
    const liveBody = JSON.stringify({profileId: liveProfile, runId: liveRun, pid: process.pid, token: 'live', startedAt: new Date().toISOString(), ...currentProcessIdentity()});
    await writeFile(livePath, liveBody);
    const second = await reconcileLeases(root);
    assert.equal(second.length, 0);
    assert.equal(await readFile(livePath, 'utf8'), liveBody);
    assert.equal(JSON.parse(await readFile(join(liveDirectory, 'status.json'), 'utf8')).status, 'executing');
    await assert.rejects(acquireWorkerLease(root, liveProfile, 'another'), (error: {code?: string}) => error.code === 'worker_busy');
    assert.equal(await readFile(livePath, 'utf8'), liveBody);
  } finally {await rm(root, {recursive: true, force: true});}
});

async function workerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hr-cleanup-'));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) => runProcess('git', args, {cwd: source, env: workerEnvironment(), timeoutMs: 5000});
  await git(['init', '-q']);
  await writeFile(join(source, 'input.txt'), 'original\n');
  await git(['add', 'input.txt']);
  await git(['-c', 'user.name=fixture', '-c', 'user.email=f@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const profile: WorkerProfile = {id: 'fixture-worker', adapter: 'codex', model: 'fixture-model', enabled: true, allowExecution: true, allowUnknownCost: true};
  const state = join(root, 'state');
  return {root, source, state, profile, async close() {await rm(root, {recursive: true, force: true});}};
}

test('worker snapshots are removed after success, failure and cancel while the patch remains', async () => {
  const fixture = await workerFixture();
  try {
    const script = (body: string) => ({command: process.execPath, args: ['-e', body], env: {}, stdin: ''});
    const cases: Array<{name: string; body: string; cancel?: boolean; fail?: boolean}> = [
      {name: 'success', body: `const f=require('node:fs');f.writeFileSync('input.txt','worker change\\n');process.stdout.write(JSON.stringify({type:'done'})+'\\n')`},
      {name: 'failure', body: 'process.exit(1)', fail: true},
      {name: 'cancel', body: 'setInterval(()=>{},1000)', cancel: true},
    ];
    for (const item of cases) {
      const protocol: WorkerProtocol = {kind: 'codex', requiredHelpFlags: [], async probe() {return {available: true};}, async invocation() {return script(item.body);}, parse() {return {text: 'Changed', cost: {status: 'unknown'}};}};
      const ledger = await BudgetLedger.open(fixture.state, 0);
      const adapter = new ProcessWorkerAdapter(fixture.profile, protocol, {roots: [fixture.source]}, fixture.state, true);
      const controller = new AbortController();
      const runDirectory = join(fixture.state, item.name);
      const context = {runId: item.name, routeId: 'fixture-worker:configured', route: workerManifests([fixture.profile])[0]!.routes[0]!, budgetUsd: 0, budget: ledger.forRun(item.name, 0), signal: controller.signal, artifactsDir: runDirectory, trace: {async event() {}}};
      const task: HarnessTask = {schemaVersion: '1.1', taskId: item.name, prompt: 'Change input.txt', requirements: ['coding'], acceptanceCriteria: [], desiredOutput: item.fail || item.cancel ? 'text' : 'patch', workspace: {root: fixture.source, mode: 'patch'}, allowUnknownCost: true};
      const pending = adapter.execute(task, context);
      if (item.cancel) {
        await new Promise(resolve => setTimeout(resolve, 50));
        controller.abort();
        await assert.rejects(pending);
      } else if (item.fail) await assert.rejects(pending);
      else {
        const result = await pending;
        assert.equal(result.status, 'completed');
        const patch = result.artifacts.find(artifact => artifact.type === 'patch');
        assert.ok(patch?.path);
        assert.match(await readFile(patch.path, 'utf8'), /worker change/);
      }
      await assert.rejects(lstat(join(runDirectory, 'workspace')), {code: 'ENOENT'});
      await ledger.close();
    }
    const kept = new ProcessWorkerAdapter(fixture.profile, {kind: 'codex', requiredHelpFlags: [], async invocation() {return {command: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({type:'done'})+'\\n')`], env: {}, stdin: ''};}, parse() {return {text: 'Kept', cost: {status: 'unknown'}};}}, {roots: [fixture.source]}, fixture.state, true, true);
    const ledger = await BudgetLedger.open(fixture.state, 0);
    const runDirectory = join(fixture.state, 'kept');
    await kept.execute({schemaVersion: '1.1', taskId: 'kept', prompt: 'Read', requirements: ['review'], acceptanceCriteria: [], desiredOutput: 'text', workspace: {root: fixture.source, mode: 'read-only'}, allowUnknownCost: true}, {runId: 'kept', routeId: 'fixture-worker:configured', route: workerManifests([fixture.profile])[0]!.routes[0]!, budgetUsd: 0, budget: ledger.forRun('kept', 0), signal: new AbortController().signal, artifactsDir: runDirectory, trace: {async event() {}}});
    assert.equal((await lstat(join(runDirectory, 'workspace'))).isDirectory(), true);
    await ledger.close();
  } finally {await fixture.close();}
});

test('prune removes old run directories and keeps recent runs and live leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-prune-'));
  try {
    const oldId = randomUUID();
    const recentId = randomUUID();
    const liveId = randomUUID();
    for (const id of [oldId, recentId, liveId]) {
      await mkdir(join(root, id), {recursive: true});
      await writeFile(join(root, id, 'status.json'), JSON.stringify({runId: id, status: 'completed'}));
    }
    const oldTime = new Date(Date.now() - 10 * 86_400_000);
    await utimes(join(root, oldId), oldTime, oldTime);
    await utimes(join(root, liveId), oldTime, oldTime);
    const leaseDir = join(root, 'worker-leases');
    await mkdir(leaseDir);
    const {createHash} = await import('node:crypto');
    await writeFile(join(leaseDir, `${createHash('sha256').update('live').digest('hex')}.json`), JSON.stringify({profileId: 'live', runId: liveId, pid: process.pid, token: 'live', startedAt: new Date().toISOString(), ...currentProcessIdentity()}));
    const dry = await pruneRuns(root, {olderThanMs: parseAge('1d'), dryRun: true});
    assert.deepEqual(dry.filter(change => change.action === 'removed').map(change => change.runId), [oldId]);
    assert.equal((await lstat(join(root, oldId))).isDirectory(), true);
    const removed = await pruneRuns(root, {olderThanMs: parseAge('1d')});
    assert.deepEqual(removed.filter(change => change.action === 'removed').map(change => change.runId), [oldId]);
    await assert.rejects(lstat(join(root, oldId)), {code: 'ENOENT'});
    assert.equal((await lstat(join(root, recentId))).isDirectory(), true);
    assert.equal((await lstat(join(root, liveId))).isDirectory(), true);
    const configDir = join(root, 'cli-config');
    await mkdir(configDir);
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, JSON.stringify({selector: 'local', artifactsDir: root, dryRun: true, allowExecution: false}));
    let stdout = '';
    assert.equal(await runCli(['prune', '--older-than', '1d', '--dry-run', '--config', configPath], {cwd: root, env: {XDG_CONFIG_HOME: join(root, 'unused-config')}, stdout: text => {stdout += text;}}), 0);
    assert.match(stdout, /No run directories matched|would remove/);
    assert.equal(await runCli(['reconcile', '--dry-run', '--config', configPath], {cwd: root, env: {XDG_CONFIG_HOME: join(root, 'unused-config')}, stdout: () => undefined}), 0);
  } finally {await rm(root, {recursive: true, force: true});}
});
