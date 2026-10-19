import test from 'node:test';
import assert from 'node:assert/strict';
import {access, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openCodeWorker} from '../../src/workers/opencode.js';
import {piWorker} from '../../src/workers/pi.js';
import {codexWorker} from '../../src/workers/codex.js';
import {claudeCodeWorker} from '../../src/workers/claude-code.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const profile: WorkerProfile = {id: 'fixture', adapter: 'opencode', model: 'fixture/model', provider: 'fixture', enabled: true, allowExecution: true};
type Call = {args: string[]; cwd: string; pid: number};
async function calls(path: string): Promise<Call[]> {
  return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call);
}
async function waitForCalls(path: string, count: number): Promise<Call[]> {
  for (let attempt = 0; attempt < 200; attempt++) {const result = await calls(path); if (result.length >= count) return result; await delay(10);}
  throw new Error('Fake metadata executable did not reach the expected stage');
}
async function fakeOpenCode(root: string, stage: 'version'|'auth'): Promise<{executable: string; log: string}> {
  const executable = join(root, 'fake-opencode'); const log = join(root, 'metadata-calls.jsonl');
  const script = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),pid:process.pid})+'\\n');
if (${JSON.stringify(stage)} === 'version' && args[0] === '--version' || ${JSON.stringify(stage)} === 'auth' && args[0] === 'auth') setInterval(() => {},1000);
else if(args[0] === '--version') console.log('1.18.15');
else if(args[0] === 'run' && args[1] === '--help') console.log('--format --model --pure --dir');
else if(args[0] === 'auth') console.log('Credentials fixture\\n0 credentials');
else process.exitCode = 1;
`;
  await writeFile(executable, script, {mode: 0o700}); return {executable, log};
}

test('mocked cancellation during OpenCode version preflight stops the child and prevents later metadata commands', {skip: process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-protocol-cancel-')); const runDirectory = join(root, 'run');
  const controller = new AbortController(); let pending: Promise<unknown>|undefined;
  try {
    const cwd = join(root, 'snapshot'); await mkdir(cwd); await mkdir(runDirectory);
    const fixture = await fakeOpenCode(root, 'version');
    pending = openCodeWorker.invocation({...profile, executable: fixture.executable}, {cwd, runDirectory, prompt: 'fixture', mode: 'read-only', signal: controller.signal});
    const started = await waitForCalls(fixture.log, 1); controller.abort(new Error('fixture cancellation'));
    await assert.rejects(pending, /cancel/i);
    assert.deepEqual((await calls(fixture.log)).map((call) => call.args), [['--version']]);
    assert.throws(() => process.kill(started[0]!.pid, 0), {code: 'ESRCH'});
  } finally {
    controller.abort(); await pending?.catch(() => {});
    await chmod(join(runDirectory, 'opencode-config', 'opencode'), 0o700).catch(() => {});
    await rm(root, {recursive: true, force: true});
  }
});

test('mocked cancellation during OpenCode metadata probe propagates the abort and cleans its isolated directory', {skip: process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-probe-cancel-')); const controller = new AbortController(); let pending: Promise<unknown>|undefined;
  try {
    const fixture = await fakeOpenCode(root, 'auth');
    pending = openCodeWorker.probe!({...profile, executable: fixture.executable}, {signal: controller.signal});
    const started = await waitForCalls(fixture.log, 3); controller.abort(new Error('fixture cancellation'));
    await assert.rejects(pending, /fixture cancellation/);
    assert.deepEqual(started.map((call) => call.args), [['--version'], ['run', '--help'], ['auth', 'list']]);
    assert.equal((await calls(fixture.log)).length, 3);
    await assert.rejects(access(started[0]!.cwd), {code: 'ENOENT'});
    assert.throws(() => process.kill(started[2]!.pid, 0), {code: 'ESRCH'});
  } finally {controller.abort(); await pending?.catch(() => {}); await rm(root, {recursive: true, force: true});}
});

test('offline pre-aborted worker invocations and SDK probes stop before creating configuration files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-before-invocation-cancel-'));
  try {
    const signal = AbortSignal.abort(new Error('fixture cancellation'));
    const options = {cwd: root, runDirectory: root, prompt: 'fixture', mode: 'read-only' as const, signal};
    for (const protocol of [codexWorker, claudeCodeWorker, piWorker, openCodeWorker]) {
      await assert.rejects(protocol.invocation({...profile, executable: undefined}, options), /fixture cancellation/);
    }
    await assert.rejects(piWorker.probe!({...profile, adapter: 'pi'}, {signal}), /fixture cancellation/);
    await assert.rejects(openCodeWorker.probe!(profile, {signal}), /fixture cancellation/);
    await assert.rejects(access(join(root, 'pi-bootstrap.json')), {code: 'ENOENT'});
    await assert.rejects(access(join(root, 'claude-settings.json')), {code: 'ENOENT'});
    await assert.rejects(access(join(root, 'opencode-config')), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
});
