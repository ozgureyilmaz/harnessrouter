import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test, {type TestContext} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {PROJECT_ROOT} from '../../src/config.js';
import type {DecisionTrace, HarnessResult, HarnessTask} from '../../src/domain/types.js';
import {codexWorker} from '../../src/workers/codex.js';

// OFFLINE LOOPBACK/FIXTURE: real MCP, HTTP, Git and subprocess transports;
// all selector responses and worker JSONL are fixtures, with no model calls.
const exec = promisify(execFile);
const MODEL = 'laya:typed-decisions';
interface RequestCapture {method?: string; path?: string; body: Record<string, unknown>; authorization?: string}
interface WorkerCapture {kind: 'help'|'execute'; model?: string; cwd: string}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-decision-mcp-')));
  let client: Client|undefined;
  let transport: StdioClientTransport|undefined;
  const requests: RequestCapture[] = [];
  const httpErrors: string[] = [];
  let choice = 'second-worker:configured';
  const http = createServer((request, response) => {
    void (async () => {
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 64 * 1024) throw new Error('Fixture request exceeds its bound');
        }
        requests.push({method: request.method, path: request.url, body: JSON.parse(body), authorization: request.headers.authorization});
        response.writeHead(200, {'content-type': 'application/json', 'x-request-id': `offline-decision-${requests.length}`});
        response.end(JSON.stringify({model: MODEL, answers: {execution_route: {type: 'choice', choice, confidence: 0.9}}, usage: {input_tokens: 23, output_tokens: 0, total_tokens: 23}}));
      } catch (error) {
        httpErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(400, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: 'Invalid offline fixture request'}));
      }
    })();
  });
  http.requestTimeout = 3000;
  t.after(async () => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    http.closeAllConnections();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {http.removeListener('error', reject); resolve();});
  });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const source = join(root, 'source');
  const state = join(root, 'state');
  const home = join(root, 'home');
  await Promise.all([mkdir(source), mkdir(home)]);
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'offline fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'offline fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost',
    HARNESSROUTER_TRUST_PROJECT_CONFIG: 'false', ROUTER_ALLOW_PAID_RUNS: 'false',
  };
  const git = (args: string[], cwd = source) => exec('git', args, {cwd, env, timeout: 5000});
  await git(['init', '--quiet', '--template=']);
  await writeFile(join(source, 'greeting.txt'), 'committed baseline\n');
  await git(['add', 'greeting.txt']);
  await git(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'offline fixture']);
  await writeFile(join(source, 'greeting.txt'), 'dirty baseline\n');
  const sourceStatus = (await git(['status', '--porcelain=v1'])).stdout;
  const workerLog = join(root, 'worker.jsonl');
  const executable = join(root, 'fixture-codex.cjs');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(${JSON.stringify(workerLog)}, JSON.stringify(value) + '\\n');
if (args.includes('--help')) {
  log({kind: 'help', cwd: process.cwd()});
  console.log(${JSON.stringify(codexWorker.requiredHelpFlags.join(' '))});
} else {
  const model = args[args.indexOf('--model') + 1];
  process.stdin.resume();
  process.stdin.on('end', () => {
    log({kind: 'execute', model, cwd: process.cwd()});
    fs.writeFileSync('greeting.txt', 'fixture patch\\n');
    for (const event of [
      {type: 'thread.started', thread_id: 'offline-worker-thread'},
      {type: 'item.completed', item: {type: 'agent_message', text: 'OFFLINE FIXTURE: updated greeting.txt.'}},
      {type: 'turn.completed', turn: {id: 'offline-turn', model, usage: {input_tokens: 11, output_tokens: 3, total_tokens: 14}}}
    ]) console.log(JSON.stringify(event));
  });
}
`);
  await chmod(executable, 0o700);
  const configPath = join(root, 'router.json');
  await writeFile(configPath, JSON.stringify({
    selector: 'decisions', decisionProvider: 'ollaya', decisionModel: MODEL,
    ollayaBaseUrl: `http://127.0.0.1:${address.port}`, decisionTimeoutMs: 3000,
    dryRun: false, allowPaid: false, allowExecution: true,
    perTaskUsd: 0, sessionUsd: 0, decisionReserveUsd: 0,
    artifactsDir: state, workspaceRoots: [source],
    workerProfiles: ['first', 'second'].map(name => ({
      id: `${name}-worker`, adapter: 'codex', model: `fixture-${name}`,
      executable, enabled: true, allowExecution: true, allowUnknownCost: true, timeoutMs: 5000,
    })),
  }));
  client = new Client({name: 'offline-decision-mcp-fixture', version: '1.0.0'}, {capabilities: {}});
  transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', join(PROJECT_ROOT, 'src/index.ts'), '--config', configPath], cwd: PROJECT_ROOT, env, stderr: 'pipe'});
  let stderr = '';
  transport.stderr?.on('data', chunk => {stderr = (stderr + chunk.toString()).slice(-4000);});
  await client.connect(transport);
  const task: HarnessTask = {
    schemaVersion: '1.1', taskId: 'offline-mcp-patch', prompt: 'Change greeting.txt only.',
    requirements: ['coding'], acceptanceCriteria: ['Patch applies to captured baseline'],
    desiredOutput: 'patch', allowUnknownCost: true, workspace: {root: source, mode: 'patch'}, timeoutMs: 15000,
  };
  return {
    root, source, state, requests, httpErrors, task, git, sourceStatus,
    setChoice(value: string) {choice = value;},
    async workers(): Promise<WorkerCapture[]> {
      try {return (await readFile(workerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    },
    async route(input: HarnessTask) {
      const reply = await client!.callTool({name: 'route_task', arguments: input as unknown as Record<string, unknown>}, undefined, {timeout: 20000});
      assert.ok(reply.structuredContent, `${JSON.stringify(reply.content)}; stderr=${stderr}`);
      return {isError: reply.isError, result: reply.structuredContent as unknown as HarnessResult};
    },
    async getRun(runId: string) {
      const reply = await client!.callTool({name: 'get_run', arguments: {runId}}, undefined, {timeout: 5000});
      assert.ok(!reply.isError && reply.structuredContent, JSON.stringify(reply.content));
      return reply.structuredContent as unknown as {result: HarnessResult; decision: DecisionTrace};
    },
  };
}

test('OFFLINE LOOPBACK/FIXTURE: stdio MCP selects a subprocess patch worker, verifies dirty baseline and replays idempotently', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const {isError, result} = await f.route(f.task);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.selectedRouteId, 'second-worker:configured');
  assert.equal(result.selectedModelId, 'fixture-second');
  assert.equal(result.criterionResults[0]?.status, 'passed');
  const patch = result.artifacts.find(artifact => artifact.type === 'patch');
  assert.ok(patch?.verified && patch.path);
  const diff = await readFile(patch.path, 'utf8');
  assert.match(diff, /-dirty baseline/);
  assert.match(diff, /\+fixture patch/);
  await f.git(['apply', '--check', patch.path]);
  assert.equal(await readFile(join(f.source, 'greeting.txt'), 'utf8'), 'dirty baseline\n');
  assert.equal((await f.git(['status', '--porcelain=v1'])).stdout, f.sourceStatus);
  const patchInfo = result.structuredOutput?.patch as {sha256: string; baselineFingerprint: string; changedFiles: string[]};
  assert.equal(patchInfo.sha256, createHash('sha256').update(diff).digest('hex'));
  assert.match(patchInfo.baselineFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(patchInfo.changedFiles, ['greeting.txt']);
  const workers = await f.workers();
  assert.ok(workers.some(worker => worker.kind === 'help'));
  assert.deepEqual(workers.filter(worker => worker.kind === 'execute').map(worker => worker.model), ['fixture-second']);
  assert.notEqual(workers.find(worker => worker.kind === 'execute')?.cwd, f.source);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.equal(request.authorization, undefined);
  assert.equal(request.body.model, MODEL);
  const questions = request.body.questions as {execution_route: {type: string; criteria: Record<string, string>}};
  assert.equal(questions.execution_route.type, 'choice');
  assert.deepEqual(Object.keys(questions.execution_route.criteria).sort(), ['first-worker:configured', 'second-worker:configured']);
  const saved = await f.getRun(result.runId);
  assert.equal(saved.decision.decisionProvider, 'ollaya');
  assert.equal(saved.decision.decisionModel, MODEL);
  assert.equal(saved.decision.selectedRouteId, 'second-worker:configured');
  assert.equal(saved.decision.decisionStatus, 'selected');
  const selectorUsage = result.usage?.find(record => record.provider === 'ollaya');
  assert.equal(selectorUsage?.model, MODEL);
  assert.equal(selectorUsage?.measurement, 'provider_reported');
  assert.equal(selectorUsage?.tokens.inputTokens, 23);
  assert.equal(selectorUsage?.tokens.outputTokens, 0);
  assert.equal(result.cost.status, 'unknown'); // Fixture Codex protocol retains honest native-cost semantics.
  assert.ok(!result.costComponents?.some(component => component.provider === 'ollaya'));
  assert.ok(result.tracePath);
  const events = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const completed = events.find(event => event.type === 'decision.completed');
  assert.equal(completed.data.provider, 'ollaya');
  assert.equal(completed.data.model, MODEL);
  assert.deepEqual(completed.data.cost.status, 'not_applicable');
  assert.equal(completed.data.cost.usd, 0);
  try {
    const ledger = JSON.parse(await readFile(join(f.state, 'budget.json'), 'utf8'));
    assert.equal(ledger.committedUsd, 0);
    assert.deepEqual(ledger.entries, []);
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const replay = await f.route(f.task);
  assert.equal(replay.result.runId, result.runId);
  assert.deepEqual(replay.result, result);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.workers(), workers);
  assert.deepEqual(f.httpErrors, []);
});

test('OFFLINE LOOPBACK/FIXTURE: unknown decision routes never execute and denied workspaces never reach selection', {timeout: 30000}, async t => {
  const f = await fixture(t);
  f.setChoice('unoffered-worker:configured');
  const unknown = await f.route({...f.task, taskId: 'offline-mcp-unknown'});
  assert.equal(unknown.isError, true);
  assert.equal(unknown.result.status, 'failed');
  assert.equal(unknown.result.error?.code, 'invalid_decision');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.workers()).filter(worker => worker.kind === 'execute').length, 0);
  const saved = await f.getRun(unknown.result.runId);
  assert.equal(saved.decision.decisionStatus, 'invalid_response');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  const denied = await f.route({...f.task, taskId: 'offline-mcp-denied', workspace: {root: outside, mode: 'patch'}});
  assert.equal(denied.isError, true);
  assert.equal(denied.result.status, 'rejected', JSON.stringify(denied.result));
  assert.equal(f.requests.length, 1);
  assert.equal((await f.workers()).filter(worker => worker.kind === 'execute').length, 0);
  assert.equal(await readFile(join(f.source, 'greeting.txt'), 'utf8'), 'dirty baseline\n');
  assert.equal((await f.git(['status', '--porcelain=v1'])).stdout, f.sourceStatus);
  assert.deepEqual(f.httpErrors, []);
});
