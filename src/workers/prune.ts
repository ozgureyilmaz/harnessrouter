import {lstat, readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {classifyLease, type WorkerLease} from './lease.js';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PruneChange {runId: string; action: 'removed' | 'skipped'; reason: string}
export interface PruneOptions {olderThanMs: number; dryRun?: boolean}

export function parseAge(value: string): number {
  const match = /^(\d+)(d|h|m|s)$/.exec(value.trim());
  if (!match) throw new Error('--older-than must be a duration like 7d, 12h, 30m, or 45s');
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('--older-than must be at least 1');
  const unit = match[2] === 'd' ? 86_400_000 : match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : 1000;
  return amount * unit;
}

/** Remove terminal run directories older than the cutoff. A live lease always keeps its run. */
export async function pruneRuns(artifactsDir: string, options: PruneOptions): Promise<PruneChange[]> {
  if (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 1) throw new Error('older-than must be a positive duration');
  const protectedRuns = await liveLeaseRunIds(artifactsDir);
  let names: string[];
  try { names = await readdir(artifactsDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const changes: PruneChange[] = [];
  const cutoff = Date.now() - options.olderThanMs;
  for (const name of names) {
    if (!RUN_ID.test(name)) continue;
    const directory = join(artifactsDir, name);
    const stat = await lstat(directory);
    if (!stat.isDirectory()) continue;
    if (protectedRuns.has(name)) { changes.push({runId: name, action: 'skipped', reason: 'live worker lease'}); continue; }
    if (stat.mtimeMs > cutoff) { changes.push({runId: name, action: 'skipped', reason: 'newer than cutoff'}); continue; }
    if (!options.dryRun) await rm(directory, {recursive: true, force: true});
    changes.push({runId: name, action: 'removed', reason: options.dryRun ? 'would remove' : 'removed'});
  }
  return changes;
}

async function liveLeaseRunIds(artifactsDir: string): Promise<Set<string>> {
  const directory = join(artifactsDir, 'worker-leases');
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  const live = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const lease = JSON.parse(await readFile(join(directory, name), 'utf8')) as WorkerLease;
      if (classifyLease(lease) !== 'dead') live.add(lease.runId);
    } catch { /* unreadable lease: do not delete a run we cannot classify */ }
  }
  return live;
}
