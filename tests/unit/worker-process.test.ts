import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runProcess, workerEnvironment} from '../../src/workers/process.js';
import {acquireWorkerLease, classifyLease, currentProcessIdentity, psEtimeToMs} from '../../src/workers/lease.js';

const processEnv = {...process.env};
const waitForFile = async (path: string, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error(`fixture did not create readiness file: ${path}`);
};
const processRunning = (pid: number): boolean => {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'});
  if (result.status !== 0) return false;
  return !result.stdout.trim().startsWith('Z');
};


test('runProcess parses bounded newline-delimited JSON records', async () => {
  const result = await runProcess(process.execPath, ['-e', `process.stdout.write('{"kind":"first"}\\n'); process.stdout.write('{"kind":"last"}')`], {
    cwd: process.cwd(), env: processEnv, timeoutMs: 3000, ndjson: true,
  });
  assert.deepEqual(result.records, [{kind: 'first'}, {kind: 'last'}]);
  assert.equal(result.stdout, '');
  assert.equal(result.exitCode, 0);
});

test('runProcess rejects malformed and oversized NDJSON events', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', `process.stdout.write('not json\\n')`], {
    cwd: process.cwd(), env: processEnv, timeoutMs: 3000, ndjson: true,
  }), (error: {code?: string}) => error.code === 'worker_invalid_output');

  await assert.rejects(runProcess(process.execPath, ['-e', `process.stdout.write(JSON.stringify({kind:'oversized'}))`], {
    cwd: process.cwd(), env: processEnv, timeoutMs: 3000, ndjson: true, maxBytes: 128, maxRecordBytes: 8,
  }), (error: {code?: string}) => error.code === 'worker_output_limit');
});

test('runProcess rejects nonzero exits without exposing stderr content', async () => {
  const resultError = await runProcess(process.execPath, ['-e', `process.stderr.write('private-marker'); process.exit(7)`], {
    cwd: process.cwd(), env: processEnv, timeoutMs: 3000,
  }).then(() => undefined, error => error as Error & {code?: string});
  assert.equal(resultError?.code, 'worker_exit_failed');
  assert.ok(resultError?.message.includes('stderr bytes='));
  assert.equal(resultError?.message.includes('private-marker'), false);
});

test('runProcess aborts a started local child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-abort-'));
  try {
    const ready = join(dir, 'ready');
    const controller = new AbortController();
    const child = runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{}, 1000)`], {
      cwd: dir, env: processEnv, signal: controller.signal, timeoutMs: 3000,
    });
    await waitForFile(ready);
    controller.abort();
    await assert.rejects(child, (error: {code?: string}) => error.code === 'cancelled');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('runProcess timeout terminates a started local child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-timeout-'));
  try {
    const ready = join(dir, 'ready');
    const child = runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{}, 1000)`], {
      cwd: dir, env: processEnv, timeoutMs: 3000,
    });
    await waitForFile(ready);
    await assert.rejects(child, (error: {code?: string}) => error.code === 'worker_timeout');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('runProcess kills a SIGTERM-ignoring descendant before abort settles (POSIX)', {skip: process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-descendant-'));
  let descendantPid: number|undefined;
  try {
    const ready = join(dir, 'descendant.pid');
    const parentSource = [
      `const fs = require('node:fs');`,
      `const {spawn} = require('node:child_process');`,
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")}], {stdio:'ignore'});`,
      `descendant.once('spawn', () => { fs.writeFileSync(${JSON.stringify(ready)}, String(descendant.pid)); });`,
      `process.on('SIGTERM', () => process.exit(0));`,
      `setInterval(()=>{},1000);`,
    ].join('\n');
    const controller = new AbortController();
    const leader = runProcess(process.execPath, ['-e', parentSource], {
      cwd: dir, env: processEnv, signal: controller.signal, timeoutMs: 3000,
    });
    await waitForFile(ready);
    descendantPid = Number(await readFile(ready, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    controller.abort();
    await assert.rejects(leader, (error: {code?: string}) => error.code === 'cancelled');
    assert.equal(processRunning(descendantPid), false, `descendant ${descendantPid} was still running after runProcess settled`);
  } finally {
    if (descendantPid && processRunning(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* best-effort cleanup of only this fixture's PID */ }
    }
    await rm(dir, {recursive: true, force: true});
  }
});

test('workerEnvironment omits arbitrary inherited secrets and keeps documented provider credentials', () => {
  const names = ['HARNESSROUTER_TEST_SECRET', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.HARNESSROUTER_TEST_SECRET = 'arbitrary-secret-sentinel';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-sentinel';
    process.env.OPENAI_API_KEY = 'openai-key-sentinel';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key-sentinel';
    const env = workerEnvironment();
    assert.equal(env.HARNESSROUTER_TEST_SECRET, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, 'openai-key-sentinel');
    assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-key-sentinel');
    assert.equal(env.HARNESSROUTER_DELEGATION_DEPTH, '1');
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('worker leases serialize concurrent callers and can be reacquired only after release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-lease-'));
  try {
    const contenders = await Promise.allSettled([
      acquireWorkerLease(dir, 'same-profile', 'run-a'),
      acquireWorkerLease(dir, 'same-profile', 'run-b'),
    ]);
    const winners = contenders.filter((item): item is PromiseFulfilledResult<() => Promise<void>> => item.status === 'fulfilled');
    const losers = contenders.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal((losers[0]!.reason as {code?: string}).code, 'worker_busy');
    await winners[0]!.value();
    const releaseAgain = await acquireWorkerLease(dir, 'same-profile', 'run-c');
    await releaseAgain();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('ps elapsed time parses BSD etime and rejects malformed values', () => {
  assert.equal(psEtimeToMs('00:00'), 0);
  assert.equal(psEtimeToMs('  03:04'), 184000);
  assert.equal(psEtimeToMs('01:02:03'), ((1 * 60 + 2) * 60 + 3) * 1000);
  assert.equal(psEtimeToMs('2-01:02:03'), (((2 * 24 + 1) * 60 + 2) * 60 + 3) * 1000);
  assert.equal(psEtimeToMs('99:99'), undefined);
  assert.equal(psEtimeToMs('nope'), undefined);
});

test('a live child pid stays busy and a mismatched start time is dead', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {stdio: 'ignore'});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    assert.equal(typeof child.pid, 'number');
    const identity = currentProcessIdentity();
    const base = {profileId: 'child', runId: 'child-run', pid: child.pid!, token: 'child', startedAt: new Date().toISOString(), hostname: identity.hostname, ...(identity.bootId ? {bootId: identity.bootId} : {})};
    assert.equal(classifyLease({...base, processStartedAt: new Date().toISOString()}), 'alive');
    assert.equal(classifyLease({...base, processStartedAt: '2000-01-01T00:00:00.000Z'}), 'dead');
  } finally { child.kill('SIGKILL'); }
});

test('worker lease reclaims a dead pid and leaves a live pid busy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessrouter-stale-lease-'));
  try {
    const {currentProcessIdentity} = await import('../../src/workers/lease.js');
    const profileId = 'stale-profile';
    const leaseDir = join(dir, 'worker-leases');
    await mkdir(leaseDir, {recursive: true, mode: 0o700});
    const path = join(leaseDir, `${createHash('sha256').update(profileId).digest('hex')}.json`);
    const stale = JSON.stringify({profileId, runId: 'previous-run', pid: 987654321, token: 'stale-owner', startedAt: '2020-01-01T00:00:00.000Z', hostname: currentProcessIdentity().hostname, processStartedAt: '2020-01-01T00:00:00.000Z'});
    await writeFile(path, stale, {mode: 0o600, flag: 'wx'});
    const release = await acquireWorkerLease(dir, profileId, 'retry-run');
    const reclaimed = JSON.parse(await readFile(path, 'utf8')) as {runId: string; pid: number};
    assert.equal(reclaimed.runId, 'retry-run');
    assert.equal(reclaimed.pid, process.pid);
    await release();
    const live = JSON.stringify({profileId, runId: 'live-run', pid: process.pid, token: 'live-owner', startedAt: new Date().toISOString(), ...currentProcessIdentity()});
    await writeFile(path, live, {mode: 0o600, flag: 'wx'});
    await assert.rejects(acquireWorkerLease(dir, profileId, 'other-run'), (error: {code?: string}) => error.code === 'worker_busy');
    assert.equal(await readFile(path, 'utf8'), live);
  } finally { await rm(dir, {recursive: true, force: true}); }
});


test('runProcess preserves RPC input until an actual terminal event, then closes it',async()=>{
  const code=`let seen=false;process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{const request=JSON.parse(data);if(request.type!=='prompt')process.exit(2);seen=true;setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'),20)});process.stdin.on('end',()=>process.exit(seen?0:3));`;
  const result=await runProcess(process.execPath,['-e',code],{cwd:process.cwd(),env:{PATH:process.env.PATH},timeoutMs:3000,ndjson:true,stdin:JSON.stringify({type:'prompt'})+'\n',closeStdinOnEvent:'agent_end'});
  assert.deepEqual(result.records,[{type:'agent_end'}]);
});
