import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {piProtocol} from '../../src/workers/pi.js';
import {assertOpenCodeAuthMetadata, assertOpenCodeSnapshot, openCodePermissions, openCodeProtocol, prepareOpenCodeIsolation} from '../../src/workers/opencode.js';
import {guardedPiPath, isolatedPiResourceLoader, isolatedPiTools} from '../../src/workers/pi-bootstrap.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const pi: WorkerProfile = {id: 'pi-test', adapter: 'pi', enabled: true, model: 'fixture-model', provider: 'fixture-provider', allowExecution: true};
const opencode: WorkerProfile = {...pi, id: 'opencode-test', adapter: 'opencode', model: 'fixture-provider/fixture-model'};
const assistant = {role: 'assistant', provider: pi.provider, model: pi.model, stopReason: 'stop', content: [{type: 'text', text: 'Done'}], usage: {input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: {total: 0}}};

test('mocked Pi native completion requires terminal event, model binding and normal stop; billing stays unknown', () => {
  const acknowledgement = {type: 'response', id: 'task', command: 'prompt', success: true, data: {disposition: 'started'}};
  const records = [acknowledgement, {type: 'message_end', message: assistant}, {type: 'agent_end', messages: [assistant]}];
  const result = piProtocol.parse(records, pi);
  assert.equal(result.text, 'Done'); assert.equal(result.cost.status, 'unknown'); assert.equal(result.usage?.[0]?.tokens.inputTokens, 5);
  assert.throws(() => piProtocol.parse(records.slice(0, 2), pi), /agent_end/);
  assert.throws(() => piProtocol.parse([acknowledgement, {...records[1], message: {...assistant, model: 'other'}}, records[2]!], pi), /model/);
  assert.throws(() => piProtocol.parse([acknowledgement, {...records[1], message: {...assistant, stopReason: 'error'}}, records[2]!], pi), /did not complete/);
  assert.throws(() => piProtocol.parse([{type: 'worker_error'}, ...records], pi), /runtime/);
  assert.throws(() => piProtocol.parse(records.slice(1), pi), /RPC prompt response/);
  assert.throws(() => piProtocol.parse([{...acknowledgement, id: 'wrong'}, ...records.slice(1)], pi), /RPC prompt response/);
  assert.throws(() => piProtocol.parse([{...acknowledgement, success: false}, ...records.slice(1)], pi), /runtime/);
});

test('dry-run Pi full-control resources discover no native or project extensions/instructions', async () => {
  const loader = isolatedPiResourceLoader();
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills().skills, []); assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.equal(loader.getSystemPromptSource(), undefined);
  assert.deepEqual(isolatedPiTools('/fixture', 'read-only').map((tool) => tool.name), ['snapshot_read', 'snapshot_ls']);
  assert.deepEqual(isolatedPiTools('/fixture', 'patch').map((tool) => tool.name), ['snapshot_read', 'snapshot_ls', 'snapshot_write', 'snapshot_edit']);
  const runDirectory = await mkdtemp(join(tmpdir(), 'hr-pi-rpc-invocation-'));
  try {
    const invocation = await piProtocol.invocation(pi, {cwd: '/snapshot', prompt: 'private fixture prompt', mode: 'read-only', runDirectory});
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(JSON.parse(invocation.stdin!), {id: 'task', type: 'prompt', message: 'private fixture prompt'});
    assert.equal(invocation.closeStdinOnEvent, 'agent_end');
    assert.ok(!invocation.args.some((arg) => arg.includes('private fixture prompt')));
    assert.ok(!invocation.args.includes('--continue')); assert.equal(invocation.env?.PI_SKIP_VERSION_CHECK, '1');
    const configPath = join(runDirectory, 'pi-bootstrap.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config, {cwd: '/snapshot', mode: 'read-only', runDirectory, provider: pi.provider, model: pi.model});
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal('prompt' in config, false);
    assert.ok(invocation.args.includes('--config')); assert.ok(invocation.args.includes(configPath));
  } finally {await rm(runDirectory, {recursive: true, force: true});}
});

test('dry-run Pi file tools reject traversal, symlink escape and .git; permit bounded patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-pi-tools-'));
  try {
    const snapshot = join(root, 'snapshot'); const outside = join(root, 'outside');
    await mkdir(snapshot); await mkdir(outside); await writeFile(join(outside, 'secret'), 'fixture');
    await symlink(outside, join(snapshot, 'escape')); await symlink(join(outside, 'missing'), join(snapshot, 'dangling'));
    await assert.rejects(guardedPiPath(snapshot, '../outside/secret'), /PERMISSION_DENIED/);
    await assert.rejects(guardedPiPath(snapshot, 'escape/secret'), /PERMISSION_DENIED/);
    await assert.rejects(guardedPiPath(snapshot, '.git/config'), /PERMISSION_DENIED/);
    await assert.rejects(guardedPiPath(snapshot, 'dangling'), /PERMISSION_DENIED/);
    assert.equal(await guardedPiPath(snapshot, 'new/file.ts'), join(await realpath(snapshot), 'new/file.ts'));
    const tool = isolatedPiTools(snapshot, 'patch').find((item) => item.name === 'snapshot_write')!;
    await tool.execute('fixture', {path: 'result.txt', content: 'bounded'}, undefined, undefined, {} as never);
    assert.equal(await readFile(join(snapshot, 'result.txt'), 'utf8'), 'bounded');
    await assert.rejects(tool.execute('fixture', {path: 'escape/secret', content: 'bad'}, undefined, undefined, {} as never), /PERMISSION_DENIED/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('mocked OpenCode events require final step and one session, no invented billing', () => {
  const records = [{type: 'text', sessionID: 'fresh', part: {text: 'Done'}}, {type: 'step_finish', sessionID: 'fresh', part: {reason: 'stop', cost: 0, tokens: {input: 10, output: 2}}}];
  assert.equal(openCodeProtocol.parse(records, opencode).cost.status, 'unknown');
  assert.throws(() => openCodeProtocol.parse(records.slice(0, 1), opencode), /step_finish/);
  assert.throws(() => openCodeProtocol.parse([{type: 'error'}, ...records], opencode), /reported an error/);
  assert.throws(() => openCodeProtocol.parse([...records, {type: 'text', sessionID: 'different', part: {text: 'mixed'}}], opencode), /identity/);
});

test('dry-run OpenCode policy forbids shell, delegation, network, external directory and repository metadata', async () => {
  const policy = openCodePermissions('/snapshot', 'patch');
  for (const name of ['bash', 'task', 'skill', 'external_directory', 'webfetch', 'websearch']) assert.equal(policy[name], 'deny');
  assert.equal((policy.edit as Record<string, string>)['/snapshot/.git/*'], 'deny');
  assert.equal(openCodePermissions('/snapshot', 'read-only').edit, 'deny');
  assert.deepEqual(openCodeProtocol.requiredHelpFlags, ['--format', '--model', '--pure', '--dir']);
});


test('mocked OpenCode credential metadata permits only classified api/oauth; rejects remote-config credentials', () => {
  assert.doesNotThrow(() => assertOpenCodeAuthMetadata('Credentials ~/.local/share/opencode/auth.json\n│  ●  OpenAI oauth\n│  ●  Anthropic api\n└  2 credentials\n'));
  assert.doesNotThrow(() => assertOpenCodeAuthMetadata('Credentials ~/.local/share/opencode/auth.json\n└  0 credentials\n'));
  assert.throws(() => assertOpenCodeAuthMetadata('Credentials\n│  ●  organization wellknown\n└  1 credentials'), /ISOLATION_UNAVAILABLE/);
  assert.throws(() => assertOpenCodeAuthMetadata('Credentials\n│  ●  provider unknown\n└  1 credentials'), /classified/);
  assert.throws(() => assertOpenCodeAuthMetadata('unrecognized format'), /ISOLATION_UNAVAILABLE/);
});

test('dry-run OpenCode isolation retains native auth location without native account DB, config plugins or package installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-opencode-isolation-'));
  try {
    const env = await prepareOpenCodeIsolation(root, '/snapshot', 'read-only');
    assert.equal(env.XDG_DATA_HOME, undefined); // supervisor inherits the native auth store, no token copy
    assert.equal(env.OPENCODE_DB, join(root, 'opencode-isolated.db'));
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1'); assert.equal(env.OPENCODE_PURE, '1');
    assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1'); assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    assert.deepEqual(config.mcp, {}); assert.deepEqual(config.plugin, []); assert.equal(config.lsp, false);
    assert.equal((await stat(env.OPENCODE_CONFIG_DIR!)).mode & 0o222, 0);
    const snapshot = join(root, 'snapshot'); await mkdir(snapshot); await assertOpenCodeSnapshot(snapshot);
    await symlink(root, join(snapshot, 'escape'));
    await assert.rejects(assertOpenCodeSnapshot(snapshot), /symlink/);
    await assert.rejects(assertOpenCodeSnapshot('/bad*path'), /permission path/);
  } finally {await chmod(join(root, 'opencode-config', 'opencode'), 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});

test('offline Pi probe resolves the pinned ESM-only SDK without CommonJS require',async()=>{
  const result=await piProtocol.probe!({...pi,executable:undefined});
  assert.equal(result.available,true,result.reason??'Pinned Pi SDK should be available');
  assert.equal(result.modelId,pi.model);
});
