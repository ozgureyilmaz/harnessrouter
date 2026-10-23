import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexWorker} from '../../src/workers/codex.js';
import {claudeCodeWorker} from '../../src/workers/claude-code.js';
import {prepareOpenCodeIsolation} from '../../src/workers/opencode.js';
import {piWorker} from '../../src/workers/pi.js';
import {parseWorkerProfiles} from '../../src/workers/config.js';
import {mcpTrace} from '../../src/workers/mcp-allowlist.js';
import {startServer} from '../../src/server.js';
import {loadConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {RouterError} from '../../src/domain/errors.js';
import {redact} from '../../src/observability/trace.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const codex: WorkerProfile = {id: 'codex-worker', adapter: 'codex', enabled: true, allowExecution: true, model: 'gpt-6-luna'};
const claude: WorkerProfile = {...codex, adapter: 'claude-code', model: 'claude-sonnet-4-5'};
const docs = {name: 'docs', command: '/usr/bin/docs-mcp', args: ['--stdio']};

test('workers forward no MCP servers unless the profile opts in', async () => {
  const codexRun = await codexWorker.invocation(codex, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only', runDirectory: '/tmp/run'});
  assert.equal(codexRun.args[codexRun.args.indexOf('-c') + 1], 'mcp_servers={}');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hr-mcp-default-')));
  try {
    const claudeRun = await claudeCodeWorker.invocation(claude, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only', runDirectory: dir});
    assert.equal(claudeRun.args[claudeRun.args.indexOf('--allowedTools') + 1], 'mcp__harnessrouter_workspace__*');
    const settings = JSON.parse(await readFile(join(dir, 'claude-settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['mcp__harnessrouter_workspace__*']);
    const mcp = JSON.parse(await readFile(join(dir, 'claude-mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['harnessrouter_workspace']);
    const env = await prepareOpenCodeIsolation(dir, '/snapshot', 'read-only');
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp, {});
    assert.deepEqual(mcpTrace(undefined), []);
  } finally { await chmod(join(dir, 'opencode-config', 'opencode'), 0o700).catch(() => {}); await rm(dir, {recursive: true, force: true}); }
});

test('an explicit allowlist adds only the named stdio server', async () => {
  const profile = {...codex, mcpServers: [docs, {name: 'notes', command: 'notes-mcp'}]};
  const codexRun = await codexWorker.invocation(profile, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'patch', runDirectory: '/tmp/run'});
  assert.equal(codexRun.args[codexRun.args.indexOf('-c') + 1], 'mcp_servers={"docs":{"command":"/usr/bin/docs-mcp","args":["--stdio"]},"notes":{"command":"notes-mcp"}}');
  assert.equal(codexRun.args.includes('features.multi_agent=false'), true);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hr-mcp-optin-')));
  try {
    const claudeRun = await claudeCodeWorker.invocation({...claude, mcpServers: [docs]}, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'patch', runDirectory: dir});
    assert.equal(claudeRun.args[claudeRun.args.indexOf('--allowedTools') + 1], 'mcp__harnessrouter_workspace__*,mcp__docs__*');
    assert.equal(claudeRun.args[claudeRun.args.indexOf('--tools') + 1], '');
    const settings = JSON.parse(await readFile(join(dir, 'claude-settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['mcp__harnessrouter_workspace__*', 'mcp__docs__*']);
    const mcp = JSON.parse(await readFile(join(dir, 'claude-mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['harnessrouter_workspace', 'docs']);
    assert.equal(mcp.mcpServers.harnessrouter_workspace.command, process.execPath);
    assert.deepEqual(mcp.mcpServers.docs, {command: '/usr/bin/docs-mcp', args: ['--stdio']});
    const env = await prepareOpenCodeIsolation(dir, '/snapshot', 'read-only', undefined, [docs]);
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp, {docs: {type: 'local', command: ['/usr/bin/docs-mcp', '--stdio'], enabled: true}});
    assert.deepEqual(mcpTrace(profile.mcpServers), [{name: 'docs', command: 'docs-mcp'}, {name: 'notes', command: 'notes-mcp'}]);
    assert.equal(JSON.stringify(mcpTrace(profile.mcpServers)).includes('--stdio'), false);
  } finally { await chmod(join(dir, 'opencode-config', 'opencode'), 0o700).catch(() => {}); await rm(dir, {recursive: true, force: true}); }
});

test('config rejects reserved names, shells, Pi, extra keys, and inline secrets', () => {
  const base = {id: 'codex-worker', adapter: 'codex', model: 'gpt-6-luna'};
  const secret = 'sk-' + 'abcdefghijklmnop';
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'harnessrouter', command: 'docs-mcp'}]}]), /MCP server name is reserved/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'harnessrouter_workspace', command: 'docs-mcp'}]}]), /must match pattern/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'bash'}]}]), /cannot be a shell/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: '/bin/zsh'}]}]), /cannot be a shell/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'harnessrouter'}]}]), /cannot launch harnessrouter/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'node', args: ['/opt/bin/harnessrouter']}]}]), /cannot launch harnessrouter/);
  assert.throws(() => parseWorkerProfiles([{...base, adapter: 'pi', provider: 'openai', mcpServers: [{name: 'docs', command: 'docs-mcp'}]}]), /Pi does not accept additional MCP servers/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'docs-mcp', env: {TOKEN: 'x'}}]}]), /Unrecognized key/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'docs-mcp', url: 'http://127.0.0.1'}]}]), /Unrecognized key/);
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'docs-mcp', args: [secret]}]}]), (error: unknown) => {
    assert.ok(error instanceof RouterError);
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /credential/);
    return true;
  });
  assert.throws(() => parseWorkerProfiles([{...base, mcpServers: [{name: 'docs', command: 'docs-mcp'}, {name: 'docs', command: 'other-mcp'}]}]), /unique/);
  assert.equal(parseWorkerProfiles([{...base, mcpServers: []}])[0]?.mcpServers, undefined);
  assert.deepEqual(parseWorkerProfiles([{...base, mcpServers: [docs]}])[0]?.mcpServers, [docs]);
});

test('Pi invocation refuses an allowlist that bypassed config parsing', async () => {
  await assert.rejects(piWorker.invocation({...codex, adapter: 'pi', provider: 'openai', executable: undefined, mcpServers: [docs]}, {cwd: '/tmp/worker', prompt: 'inspect', mode: 'read-only', runDirectory: '/tmp/run'}), /Pi does not accept additional MCP servers/);
});

test('traces redact a credential that a caller places beside an allowlist name', () => {
  const secret = 'sk-' + 'abcdefghijklmnop';
  const traced = redact({mcpServers: mcpTrace([docs]), leaked: secret});
  assert.equal(JSON.stringify(traced).includes(secret), false);
  assert.equal(JSON.stringify(traced).includes('--stdio'), false);
});

test('listHarnesses reports allowlist names and omits commands', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-mcp-list-')));
  const ledger = await BudgetLedger.open(join(root, 'runs'), 0);
  try {
    await mkdir(join(root, 'config', 'harnessrouter'), {recursive: true});
    await writeFile(join(root, 'config', 'harnessrouter', 'config.json'), JSON.stringify({
      selector: 'local',
      workerProfiles: [{...codex, enabled: false, allowExecution: false, mcpServers: [docs]}],
    }));
    const config = loadConfig({cwd: root, env: {XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), ROUTER_SELECTOR: 'local'}});
    const listing = await new HarnessRouter(config, [], ledger).listHarnesses();
    assert.deepEqual(listing.mcpAllowlists, [{id: 'codex-worker', servers: ['docs']}]);
    assert.equal(JSON.stringify(listing).includes('/usr/bin/docs-mcp'), false);
    assert.equal(JSON.stringify(listing).includes('--stdio'), false);
  } finally { await ledger.close(); await rm(root, {recursive: true, force: true}); }
});

test('startServer refuses to run inside a worker', async () => {
  const previous = process.env.HARNESSROUTER_WORKER;
  process.env.HARNESSROUTER_WORKER = '1';
  try {
    await assert.rejects(startServer({}), (error: unknown) => {
      assert.ok(error instanceof RouterError);
      assert.equal(error.code, 'recursive_delegation_denied');
      assert.match(error.message, /cannot recursively launch harnessrouter/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.HARNESSROUTER_WORKER;
    else process.env.HARNESSROUTER_WORKER = previous;
  }
});
