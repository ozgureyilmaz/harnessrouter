import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexWorker} from '../../src/workers/codex.js';
import {CodexAppServerSession, parseCodexAppServer} from '../../src/workers/codex-app-server.js';
import {parseWorkerProfiles} from '../../src/workers/config.js';
import {ProcessWorkerAdapter, workerTaskPrompt} from '../../src/workers/adapter.js';
import {runProcess, workerEnvironment} from '../../src/workers/process.js';
import {RouterError} from '../../src/domain/errors.js';
import type {ExecutionContext, HarnessTask} from '../../src/domain/types.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const profile: WorkerProfile = {id: 'codex-worker', adapter: 'codex', enabled: true, allowExecution: true, allowUnknownCost: true, model: 'gpt-6-luna', codexTransport: 'app-server'};
const messages = (value: string | undefined) => (value ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

test('the default Codex transport stays the closed exec invocation', async () => {
  const run = await codexWorker.invocation({...profile, codexTransport: undefined}, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only', runDirectory: '/tmp/run'});
  assert.deepEqual(run.args, ['exec', '--json', '--ignore-user-config', '--ephemeral', '--strict-config', '--sandbox', 'read-only', '--model', 'gpt-6-luna', '-C', '/tmp/worker', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false', '-']);
  assert.equal(codexWorker.stdioSession?.({...profile, codexTransport: undefined}, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only'}), undefined);
});

test('app-server config is Codex-only and the client never resumes a thread', async () => {
  assert.equal(parseWorkerProfiles([{id: 'codex-worker', adapter: 'codex', model: 'gpt-6-luna', codexTransport: 'app-server'}])[0]?.codexTransport, 'app-server');
  assert.equal(parseWorkerProfiles([{id: 'codex-worker', adapter: 'codex', model: 'gpt-6-luna', codexTransport: 'cli'}])[0]?.codexTransport, undefined);
  assert.throws(() => parseWorkerProfiles([{id: 'claude-worker', adapter: 'claude-code', model: 'claude-sonnet-4-5', codexTransport: 'app-server'}]), /only valid on a Codex worker/);
  assert.throws(() => parseWorkerProfiles([{id: 'pi-worker', adapter: 'pi', model: 'gpt-6-luna', provider: 'openai', codexTransport: 'app-server'}]), /only valid on a Codex worker/);
  const run = await codexWorker.invocation(profile, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only', runDirectory: '/tmp/run'});
  assert.deepEqual(run.args, ['app-server', '--listen', 'stdio://']);
  const session = new CodexAppServerSession(profile, {cwd: '/snap', prompt: 'Review the files', mode: 'read-only'});
  const spoken = [session.opening, session.respond({method: 'account/updated', params: {}}), session.respond({id: 1, result: {userAgent: 'fake'}}), session.respond({id: 2, result: {thread: {id: 'thr_1'}}}), session.respond({method: 'turn/started', params: {turn: {id: 'turn_1', status: 'inProgress'}}}), session.interrupt()];
  const flat = spoken.flatMap(messages);
  assert.deepEqual(flat.map((message) => message.method), ['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/interrupt']);
  assert.equal(JSON.stringify(flat).includes('thread/resume'), false);
  assert.equal((flat[2]!.params as {sandbox: string}).sandbox, 'readOnly');
  assert.equal((flat[2]!.params as {approvalPolicy: string}).approvalPolicy, 'never');
  assert.equal((flat[3]!.params as {sandboxPolicy: {type: string}}).sandboxPolicy.type, 'readOnly');
  const patch = new CodexAppServerSession(profile, {cwd: '/snap', prompt: 'Edit', mode: 'patch'});
  patch.respond({id: 1, result: {}});
  const turn = messages(patch.respond({id: 2, result: {thread: {id: 'thr_2'}}}))[0]!;
  assert.deepEqual((turn.params as {sandboxPolicy: unknown}).sandboxPolicy, {type: 'workspaceWrite', writableRoots: ['/snap'], networkAccess: false});
});

test('an app-server approval request is denied and its command is not copied into the error', () => {
  const session = new CodexAppServerSession(profile, {cwd: '/snap', prompt: 'Review', mode: 'read-only'});
  session.respond({id: 1, result: {}});
  session.respond({id: 2, result: {thread: {id: 'thr_1'}}});
  const denied = session.respond({id: 9, method: 'item/commandExecution/requestApproval', params: {command: 'rm -rf /'}}) ?? '';
  assert.equal(denied.includes('rm -rf'), false);
  assert.equal(session.failure?.code, 'permission_required');
  assert.match(session.failure?.message ?? '', /does not grant/);
  const secret = 'sk-' + 'abcdefghijklmnop';
  assert.throws(() => parseCodexAppServer([{id: 1, error: {message: secret}}], profile), (error: unknown) => {
    assert.match(String(error), /returned an error/);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test('app-server parser accepts a completed agent message and rejects a bad model', () => {
  const parsed = parseCodexAppServer([
    {id: 2, result: {thread: {id: 'thr_9'}}},
    {method: 'item/completed', params: {item: {type: 'agentMessage', text: 'notes', phase: 'commentary'}}},
    {method: 'item/completed', params: {item: {type: 'agentMessage', text: 'Final from server', phase: 'final_answer'}}},
    {method: 'turn/completed', params: {turn: {id: 'turn_9', status: 'completed'}}},
  ], profile);
  assert.equal(parsed.text, 'Final from server');
  assert.equal(parsed.sessionId, 'thr_9');
  assert.equal(parsed.cost.status, 'unknown');
  assert.throws(() => parseCodexAppServer([{method: 'model/rerouted', params: {toModel: 'other-model'}}, {method: 'turn/completed', params: {turn: {status: 'completed'}}}], profile), /allowlist/);
  assert.throws(() => parseCodexAppServer([{method: 'turn/completed', params: {turn: {status: 'interrupted'}}}], profile), /interrupted/);
});

test('cancellation writes turn/interrupt before the process is killed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-app-server-cancel-')));
  const script = join(root, 'fake-codex.mjs');
  const seen = join(root, 'seen.jsonl');
  await writeFile(script, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
let buf='';
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    appendFileSync(${JSON.stringify(seen)}, line + '\\n');
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:1, result:{}}) + '\\n');
    if (msg.method === 'thread/start') process.stdout.write(JSON.stringify({id:2, result:{thread:{id:'thr_c'}}}) + '\\n');
    if (msg.method === 'turn/start') process.stdout.write(JSON.stringify({method:'turn/started', params:{turn:{id:'turn_c', status:'inProgress'}}}) + '\\n');
    if (msg.method === 'turn/interrupt') process.exit(0);
  }
});
setTimeout(() => process.exit(2), 4000);
`, {mode: 0o755});
  await chmod(script, 0o755);
  const session = new CodexAppServerSession(profile, {cwd: '/snap', prompt: 'Review', mode: 'read-only'});
  const controller = new AbortController();
  const pending = runProcess(script, ['app-server', '--listen', 'stdio://'], {cwd: root, env: {PATH: process.env.PATH}, timeoutMs: 4000, ndjson: true, stdin: session.opening, onServerRecord: (record) => session.respond(record), onAbort: () => session.interrupt(), signal: controller.signal});
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, (error: unknown) => error instanceof RouterError && error.code === 'cancelled');
  assert.match(await readFile(seen, 'utf8'), /turn\/interrupt/);
  assert.equal((await readFile(seen, 'utf8')).includes('thread/resume'), false);
  await rm(root, {recursive: true, force: true});
});

test('offline fake: the process adapter completes an app-server turn and records raw events', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-app-server-run-')));
  const source = join(root, 'source');
  const script = join(root, 'fake-codex.mjs');
  const seen = join(root, 'seen.jsonl');
  await writeFile(script, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
if (process.argv.includes('--help')) { process.stdout.write('codex app-server --listen stdio\\n'); process.exit(0); }
let buf='';
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    appendFileSync(${JSON.stringify(seen)}, line + '\\n');
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:1, result:{userAgent:'fake'}}) + '\\n');
    if (msg.method === 'thread/start') process.stdout.write(JSON.stringify({id:2, result:{thread:{id:'thr_test'}}}) + '\\n');
    if (msg.method === 'turn/start') {
      process.stdout.write(JSON.stringify({method:'turn/started', params:{turn:{id:'turn_test', status:'inProgress'}}}) + '\\n');
      process.stdout.write(JSON.stringify({method:'item/completed', params:{item:{type:'agentMessage', id:'m1', text:'App server answer', phase:'final_answer'}}}) + '\\n');
      process.stdout.write(JSON.stringify({method:'turn/completed', params:{turn:{id:'turn_test', status:'completed'}}}) + '\\n');
      process.exit(0);
    }
  }
});
`, {mode: 0o755});
  await chmod(script, 0o755);
  const {mkdir} = await import('node:fs/promises');
  await mkdir(source);
  await runProcess('git', ['init', '-q'], {cwd: source, env: workerEnvironment(), timeoutMs: 5000});
  await writeFile(join(source, 'greeting.txt'), 'before\n');
  const worker = {...profile, executable: script};
  const adapter = new ProcessWorkerAdapter(worker, codexWorker, {roots: [source]}, root, true);
  assert.equal((await adapter.health()).available, true);
  const events: string[] = [];
  const task: HarnessTask = {schemaVersion: '1.1', taskId: 'app-server-task', prompt: 'Say hello', requirements: ['review'], acceptanceCriteria: [], desiredOutput: 'text', allowUnknownCost: true, workspace: {root: source, mode: 'read-only'}};
  const ctx: ExecutionContext = {runId: randomUUID(), routeId: 'codex-worker:configured', route: {id: 'codex-worker:configured', description: 'Codex', modalities: ['text'], eligible_requirements: ['review'], price_status: 'unknown'}, budgetUsd: 0, signal: new AbortController().signal, artifactsDir: join(root, 'run'), trace: {async event(type){events.push(type);}}, budget: {remainingUsd: 0, async reserve(){return 'reservation';}, async settle(){}}};
  const result = await adapter.execute(task, ctx);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'App server answer');
  assert.equal(result.structuredOutput?.provenance && (result.structuredOutput.provenance as {sessionId: string}).sessionId, 'thr_test');
  assert.ok(events.includes('worker.raw_event'));
  const transcript = await readFile(seen, 'utf8');
  assert.equal(transcript.includes('thread/resume'), false);
  assert.match(transcript, /Say hello/);
  assert.match(workerTaskPrompt(task), /Do not stage or commit/);
  await rm(root, {recursive: true, force: true});
});
