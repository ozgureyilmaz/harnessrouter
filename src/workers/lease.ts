import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, readdir, readFile, writeFile, unlink, lstat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {RouterError} from '../domain/errors.js';
import {validateResult} from '../domain/schemas.js';
import type {HarnessResult} from '../domain/types.js';
import {deleteRunWorkspace} from '../workspace/snapshot.js';

export interface WorkerLease {
  profileId: string;
  runId: string;
  pid: number;
  token: string;
  startedAt: string;
  hostname: string;
  /** Wall-clock start of the owning process, used to detect pid reuse. */
  processStartedAt: string;
  /** Linux boot id when available, so a reboot is not mistaken for the same process. */
  bootId?: string;
}
export interface ReconcileChange {
  profileId: string;
  runId: string;
  action: 'interrupted' | 'released' | 'undecided';
  detail: string;
}
export interface ReconcileOptions {dryRun?: boolean; keepSnapshots?: boolean}

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'defer_to_host', 'permission_required', 'cancelled', 'interrupted']);
const START_TOLERANCE_MS = 5000;

export function currentProcessIdentity(): {hostname: string; processStartedAt: string; bootId?: string} {
  return {hostname: hostname(), processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), bootId: readBootId()};
}

/** `alive` means this process still owns the lease. `unknown` means it is not safe to reclaim. */
export function classifyLease(lease: WorkerLease): 'alive' | 'dead' | 'unknown' {
  const identity = currentProcessIdentity();
  if (lease.hostname !== identity.hostname) return 'dead';
  if (lease.bootId && identity.bootId && lease.bootId !== identity.bootId) return 'dead';
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return 'dead';
  const exists = pidExists(lease.pid);
  if (exists === 'dead') return 'dead';
  if (exists === 'unknown') return 'unknown';
  const actual = processStartMs(lease.pid);
  const expected = Date.parse(lease.processStartedAt);
  if (actual === undefined || !Number.isFinite(expected)) return 'unknown';
  return Math.abs(actual - expected) <= START_TOLERANCE_MS ? 'alive' : 'dead';
}

export async function reconcileLeases(stateRoot: string, options: ReconcileOptions = {}): Promise<ReconcileChange[]> {
  const directory = join(stateRoot, 'worker-leases');
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const changes: ReconcileChange[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    let lease: WorkerLease;
    try { lease = JSON.parse(await readFile(path, 'utf8')) as WorkerLease; }
    catch { changes.push({profileId: name, runId: '', action: 'undecided', detail: 'Worker lease could not be read'}); continue; }
    const verdict = classifyLease(lease);
    if (verdict === 'alive') continue;
    if (verdict === 'unknown') {
      changes.push({profileId: lease.profileId, runId: lease.runId, action: 'undecided', detail: 'Lease owner could not be identified safely'});
      continue;
    }
    const runDirectory = join(stateRoot, lease.runId);
    const transition = await interruptRun(runDirectory, lease, options.dryRun === true);
    if (!options.dryRun) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    if (!options.dryRun && !options.keepSnapshots) await deleteRunWorkspace(runDirectory).catch(() => undefined);
    changes.push({profileId: lease.profileId, runId: lease.runId, action: transition, detail: transition === 'interrupted' ? 'Dead worker lease marked the run interrupted' : 'Dead worker lease released'});
  }
  return changes;
}

/** An abandoned lease is reclaimed when its owner is dead. A live owner is worker_busy. */
export async function acquireWorkerLease(stateRoot: string, profileId: string, runId: string): Promise<() => Promise<void>> {
  await reconcileLeases(stateRoot);
  const directory = join(stateRoot, 'worker-leases');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const path = leasePath(stateRoot, profileId);
  const token = randomUUID();
  const identity = currentProcessIdentity();
  const body = JSON.stringify({profileId, runId, pid: process.pid, token, startedAt: new Date().toISOString(), ...identity});
  try { await writeFile(path, body, {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readLease(path);
    const verdict = classifyLease(owner);
    if (verdict === 'alive') throw new RouterError('worker_busy', 'Worker profile is already running a task');
    if (verdict === 'unknown') throw new RouterError('worker_reconciliation_required', 'Worker profile has a lease whose owner could not be identified; inspect it before retrying');
    await reconcileLeases(stateRoot);
    try { await writeFile(path, body, {flag: 'wx', mode: 0o600}); }
    catch (retry) { if ((retry as NodeJS.ErrnoException).code === 'EEXIST') throw new RouterError('worker_busy', 'Worker profile is already running a task'); throw retry; }
  }
  return async () => {
    const owner = JSON.parse(await readFile(path, 'utf8')) as WorkerLease;
    if (owner.token !== token) throw new RouterError('worker_lease_conflict', 'Worker lease ownership changed');
    await unlink(path);
  };
}

export function leasePath(stateRoot: string, profileId: string): string {
  return join(stateRoot, 'worker-leases', createHash('sha256').update(profileId).digest('hex') + '.json');
}

async function interruptRun(runDirectory: string, lease: WorkerLease, dryRun: boolean): Promise<'interrupted' | 'released'> {
  const readJson = async (name: string) => {
    try { return JSON.parse(await readFile(join(runDirectory, name), 'utf8')) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  let present = true;
  try { await lstat(runDirectory); } catch { present = false; }
  if (!present) return 'released';
  const [saved, status, task] = await Promise.all([readJson('result.json'), readJson('status.json'), readJson('task.json')]);
  const savedStatus = typeof saved?.status === 'string' ? saved.status : undefined;
  const recordedStatus = typeof status?.status === 'string' ? status.status : undefined;
  if ((savedStatus && TERMINAL.has(savedStatus)) || (recordedStatus && TERMINAL.has(recordedStatus))) return 'released';
  if (dryRun) return 'interrupted';
  const taskId = typeof task?.taskId === 'string' ? task.taskId : lease.runId;
  const selectedRouteId = typeof status?.selectedRouteId === 'string' ? status.selectedRouteId : null;
  const result: HarnessResult = {
    schemaVersion: '1.3', runId: lease.runId, taskId, status: 'interrupted', selectedRouteId, selectedHarnessId: null, selectedModelId: null,
    summary: 'Run interrupted because the worker process is no longer running', artifacts: [], criterionResults: [], timing: {totalMs: 0},
    cost: {status: 'unknown', details: 'Run interrupted before completion'}, usage: [], costComponents: [],
    error: {code: 'interrupted', message: 'Router or worker process ended before the run finished', retryable: true},
  };
  validateResult(result);
  await mkdir(runDirectory, {recursive: true, mode: 0o700});
  await writeFile(join(runDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  await writeFile(join(runDirectory, 'status.json'), JSON.stringify({runId: lease.runId, status: 'interrupted'}) + '\n', {mode: 0o600});
  const event = {runId: lease.runId, type: 'run.interrupted', at: new Date().toISOString(), elapsedMs: 0, data: {reason: 'dead_worker_lease', pid: lease.pid, hostname: lease.hostname, profileId: lease.profileId}};
  await appendFile(join(runDirectory, 'events.jsonl'), JSON.stringify(event) + '\n', {mode: 0o600});
  return 'interrupted';
}

async function readLease(path: string): Promise<WorkerLease> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return JSON.parse(await readFile(path, 'utf8')) as WorkerLease; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return JSON.parse(await readFile(path, 'utf8')) as WorkerLease;
}
let cachedBootId: {value: string | undefined} | undefined;
function readBootId(): string | undefined {
  if (!cachedBootId) cachedBootId = {value: loadBootId()};
  return cachedBootId.value;
}
function loadBootId(): string | undefined {
  if (process.platform === 'linux') {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
  }
  if (process.platform === 'darwin') {
    try {
      const id = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
      return /^[0-9A-Fa-f-]{36}$/.test(id) ? id : undefined;
    } catch { return undefined; }
  }
  return undefined;
}
function pidExists(pid: number): 'alive' | 'dead' | 'unknown' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}
/** Parse BSD `ps -o etime=` (`[[dd-]hh:]mm:ss`) into milliseconds. */
export function psEtimeToMs(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
function processStartMs(pid: number): number | undefined {
  // This process cannot observe a reused copy of its own pid. Compare the start time it records.
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  if (process.platform === 'linux') return linuxProcessStartMs(pid);
  if (process.platform === 'darwin') return darwinProcessStartMs(pid);
  return undefined;
}
function linuxProcessStartMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
    const hz = 100;
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptime)) return undefined;
    return Date.now() - uptime * 1000 + (startTicks / hz) * 1000;
  } catch { return undefined; }
}
function darwinProcessStartMs(pid: number): number | undefined {
  try {
    const etime = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'etime='], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']});
    const elapsed = psEtimeToMs(etime);
    if (elapsed === undefined) return undefined;
    return Date.now() - elapsed;
  } catch { return undefined; }
}
