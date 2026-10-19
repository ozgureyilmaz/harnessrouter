import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, stat, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runCli} from '../../src/cli.js';
import {generateHostConfig} from '../../src/mcp/host-config.js';
import {PROJECT_ROOT} from '../../src/config.js';

const capture = () => {
  let stdout = '';
  let stderr = '';
  return {io: {stdout: (s: string) => {stdout += s;}, stderr: (s: string) => {stderr += s;}}, get stdout() {return stdout;}, get stderr() {return stderr;}};
};

test('host snippets use native stdio shapes and safely preserve paths with spaces', () => {
  const configPath = '/tmp/user config/harnessrouter settings.json';
  const cliPath = resolve(PROJECT_ROOT, 'dist/index.js');
  const codex = generateHostConfig('codex', configPath);
  assert.ok(codex.includes('[mcp_servers.harnessrouter]'));
  assert.ok(codex.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(codex.includes(JSON.stringify(cliPath)));
  assert.ok(codex.includes(JSON.stringify(configPath)));

  const claude = JSON.parse(generateHostConfig('claude-code', configPath));
  assert.deepEqual(claude.mcpServers.harnessrouter, {command: process.execPath, args: [cliPath, '--config', configPath]});
  const pi = JSON.parse(generateHostConfig('pi', configPath));
  assert.deepEqual(pi.mcpServers.harnessrouter, {command: process.execPath, args: [cliPath, '--config', configPath], timeout: 300});
  const opencode = JSON.parse(generateHostConfig('opencode', configPath));
  assert.deepEqual(opencode.mcp.harnessrouter, {type: 'local', command: [process.execPath, cliPath, '--config', configPath], enabled: true, timeout: 300000});
  assert.match(codex, /tool_timeout_sec = 300/);
  assert.equal(pi.mcpServers.harnessrouter.timeout, 300);
  assert.equal('timeout' in claude.mcpServers.harnessrouter, false);
});

test('init writes a private disabled configuration once and refuses overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-cli-'));
  try {
    const target = join(dir, 'settings with spaces.json');
    const first = capture();
    assert.equal(await runCli(['init', '--config', target], {...first.io, cwd: dir, env: {}}), 0);
    const contents = await readFile(target, 'utf8');
    const config = JSON.parse(contents);
    assert.deepEqual({selector: config.selector, decisionProvider: config.decisionProvider, decisionModel: config.decisionModel, decisionReserveUsd: config.decisionReserveUsd, dryRun: config.dryRun, allowExecution: config.allowExecution, allowPaid: config.allowPaid}, {selector: 'decisions', decisionProvider: 'openai', decisionModel: 'gpt-6-luna', decisionReserveUsd: 0.01, dryRun: true, allowExecution: false, allowPaid: false});
    assert.equal(config.workerProfiles.length, 4);
    assert.ok(config.workerProfiles.every((profile: {enabled: boolean; allowExecution: boolean; model: string}) => !profile.enabled && !profile.allowExecution && profile.model.startsWith('set-this-to-')));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const second = capture();
    assert.equal(await runCli(['init', '--config', target], {...second.io, cwd: dir, env: {}}), 1);
    assert.match(second.stderr, /already exists|EEXIST/);
    assert.equal(await readFile(target, 'utf8'), contents);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('init supports explicit local scope and never writes inside the package by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-local-'));
  try {
    const captureOutput = capture();
    assert.equal(await runCli(['init', '--scope', 'local'], {...captureOutput.io, cwd: dir, env: {}}), 0);
    assert.ok(captureOutput.stdout.includes(join(dir, '.harnessrouter', 'config.json')));
    const config = JSON.parse(await readFile(join(dir, '.harnessrouter', 'config.json'), 'utf8'));
    assert.equal(config.allowExecution, false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('init supports a provider-specific disabled starter without keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-provider-init-'));
  try {
    const target = join(dir, 'ollaya.json');
    const output = capture();
    assert.equal(await runCli(['init', '--decision-provider', 'ollaya', '--config', target], {...output.io, cwd: dir, env: {}}), 0);
    const config = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(config.selector, 'decisions');
    assert.equal(config.decisionProvider, 'ollaya');
    assert.equal(config.decisionModel, 'laya:typed-decisions');
    assert.equal(config.decisionReserveUsd, 0);
    assert.equal(config.allowExecution, false);
    assert.equal(config.allowPaid, false);
    assert.equal('ollayaApiKey' in config, false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('CLI rejects invalid flags and unsupported host names without writing files', async () => {
  for (const args of [['--unexpected'], ['mcp-config'], ['mcp-config', '--host', 'unknown'], ['init', '--scope', 'shared'], ['mcp-config', '--host', 'pi', '--host', 'pi']]) {
    const output = capture();
    assert.equal(await runCli(args, {...output.io, cwd: tmpdir(), env: {}}), 1);
    assert.ok(output.stderr.length > 0);
  }
  const help = capture();
  assert.equal(await runCli(['mcp-config', '--help'], {...help.io, env: {}}), 0);
  assert.match(help.stdout, /harnessrouter init/);
});

test('doctor validates configuration and platform without launching worker tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({selector: 'local', dryRun: true, allowExecution: false, workerProfiles: []}));
    const output = capture();
    assert.equal(await runCli(['doctor', '--config', configPath], {...output.io, cwd: dir, env: envForCli(dir)}), 0);
    assert.match(output.stdout, /OK Node\.js:/);
    assert.match(output.stdout, /OK Package: harnessrouter/);
    assert.match(output.stdout, /OK Git:/);
    assert.match(output.stdout, /DISABLED Worker profiles: none configured/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('doctor shows active default decision provider, key presence only, and no network claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-decision-'));
  try {
    const output = capture();
    assert.equal(await runCli(['doctor'], {...output.io, cwd: dir, env: {PATH: process.env.PATH ?? '/usr/bin:/bin', XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'), OPENAI_API_KEY: 'key-value-must-not-appear'}}), 0);
    assert.match(output.stdout, /DISABLED Decision layer: selector=decisions; provider=openai; model=gpt-6-luna; OPENAI_API_KEY=present; no provider request made/);
    assert.equal(output.stdout.includes('key-value-must-not-appear'), false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('doctor reports missing active live decision credentials without probing the provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-live-decision-'));
  try {
    const configPath = join(dir, 'live.json');
    await writeFile(configPath, JSON.stringify({selector: 'decisions', decisionProvider: 'jev', dryRun: false, allowExecution: true, allowPaid: true, workerProfiles: []}));
    const output = capture();
    assert.equal(await runCli(['doctor', '--config', configPath], {...output.io, cwd: dir, env: envForCli(dir)}), 1);
    assert.match(output.stdout, /ERROR Decision layer: selector=decisions; provider=jev; model=jev-latest; TYPESAFE_API_KEY\/JEV_API_KEY=missing/);
    assert.match(output.stdout, /set TYPESAFE_API_KEY/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('doctor reports configured Ollaya as configured while leaving live availability unverified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-ollaya-'));
  try {
    const output = capture();
    const env = {XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'), ROUTER_DECISION_PROVIDER: 'ollaya', ROUTER_DRY_RUN: 'false', ROUTER_ALLOW_EXECUTION: 'true'};
    assert.equal(await runCli(['doctor'], {...output.io, cwd: dir, env}), 0);
    assert.match(output.stdout, /OK Decision layer: selector=decisions; provider=ollaya; model=laya:typed-decisions; local base URL=http:\/\/127\.0\.0\.1:11435/);
    assert.match(output.stdout, /configuration valid, no request made, live availability unverified/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

function envForCli(dir: string): NodeJS.ProcessEnv {
  return {PATH: process.env.PATH ?? '/usr/bin:/bin', XDG_CONFIG_HOME: join(dir, 'user-config'), XDG_STATE_HOME: join(dir, 'state')};
}

test('doctor exits unsuccessfully when an explicitly enabled worker lacks required CLI flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-worker-'));
  try {
    const configPath = join(dir, 'config.json');
    const executable = join(dir, 'fake-codex');
    await writeFile(executable, '#!/bin/sh\nprintf "fixture help\\n"\n', {mode: 0o700});
    await chmod(executable, 0o700);
    await writeFile(configPath, JSON.stringify({selector: 'local', dryRun: true, allowExecution: true, workerProfiles: [{id: 'codex-local', adapter: 'codex', enabled: true, allowExecution: true, model: 'gpt-6-luna', executable}]}));
    const output = capture();
    assert.equal(await runCli(['doctor', '--config', configPath], {...output.io, cwd: dir, env: {}}), 1);
    assert.match(output.stdout, /ERROR Worker codex-local: missing required CLI flags/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('doctor calls trusted protocol probes when available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-doctor-pi-'));
  try {
    const configPath = join(dir, 'config.json');
    const executable = join(dir, 'fake-pi');
    await writeFile(executable, '#!/bin/sh\nprintf "fixture help\\n"\n', {mode: 0o700});
    await chmod(executable, 0o700);
    await writeFile(configPath, JSON.stringify({selector: 'local', dryRun: true, allowExecution: true, workerProfiles: [{id: 'pi-local', adapter: 'pi', enabled: true, allowExecution: true, model: 'gpt-6-luna', provider: 'openai', executable}]}));
    const output = capture();
    const result = await runCli(['doctor', '--config', configPath], {...output.io, cwd: dir, env: {}});
    assert.equal(result, 1);
    assert.match(output.stdout, /ERROR Worker pi-local: Pi uses the pinned SDK bootstrap; executable overrides are unsupported/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
