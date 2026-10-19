import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {RouterError} from '../domain/errors.js';
import type {WorkspacePatch, WorkspacePolicy, WorkspaceRequest, WorkspaceSnapshot} from './types.js';

type Entry = {path: string; bytes: Buffer; executable: boolean};
type State = {root: string; runDirectory: string; commit: string; fingerprint: string; baseline: Entry[]; gitFingerprint: string; maxFiles: number; maxBytes: number; mode: WorkspaceRequest['mode']};
// Kept outside the worker-accessible filesystem: workers cannot replace their own baseline.
const states = new WeakMap<WorkspaceSnapshot, State>();
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fail(code: string, message: string): never {throw new RouterError(code, message);}
const inside = (root: string, child: string) => child === root || (!relative(root, child).startsWith(`..${sep}`) && relative(root, child) !== '..' && !isAbsolute(relative(root, child)));

function safePath(path: string): void {
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('workspace_path_unsafe', 'Workspace paths must be safe relative file paths');
}
export function protectedWorkspacePath(path: string): boolean {
  return path.split('/').some(part => {
    const name = part.toLowerCase();
    return ['.git', '.harnessrouter', 'node_modules', '.claude', '.pi', '.codex', '.opencode', '.cursor', '.agents', '.ssh', '.aws', '.azure', '.gnupg', 'hooks', '.hooks', '.husky', '.config', '.mcp.json', 'mcp.json', '.claude.json', 'opencode.json', 'opencode.jsonc', '.opencode.json', '.opencode.jsonc', '.cursorrules', '.clinerules', '.windsurfrules', 'system.md', 'claude.md', 'agents.md', 'gemini.md', '.npmrc', '.netrc', '.pypirc', '.gitconfig', '.gitmodules', '.gitattributes', '.gitignore'].includes(name)
      || name.startsWith('.env') || /(?:^|[._-])(?:credentials?|secrets?|auth|tokens?)(?:[._-]|$)/i.test(name)
      || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name);
  });
}
async function noSymlinks(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const absolute = resolve(path);
  let current = absolute.startsWith(sep) ? sep : '';
  for (const part of absolute.split(sep).filter(Boolean)) {
    signal?.throwIfAborted();
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('workspace_symlink', 'Workspace paths must not contain symlinks');
  }
}
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: tmpdir(), XDG_CONFIG_HOME: join(tmpdir(), 'harnessrouter-no-git-config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'harnessrouter', GIT_AUTHOR_EMAIL: 'snapshot@localhost',
    GIT_COMMITTER_NAME: 'harnessrouter', GIT_COMMITTER_EMAIL: 'snapshot@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    LC_ALL: 'C',
  };
}
async function git(cwd: string, args: string[], maxOutput = 64 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'diff.external=', ...args], {cwd, env: gitEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = () => {try {if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');} catch {}};
    const abort = () => {failure = signal?.reason instanceof Error ? signal.reason : new RouterError('cancelled', 'Workspace operation cancelled'); stop();};
    const timer = setTimeout(() => {failure = new RouterError('workspace_git_timeout', 'Workspace git operation timed out'); stop();}, 15_000);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const cleanup = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort);};
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > maxOutput) {failure = new RouterError('workspace_limit', 'Workspace git output exceeds limit'); stop();} else chunks.push(data);
    });
    // Drain but never return potentially sensitive provider/configuration stderr.
    child.stderr.resume();
    child.on('error', error => {cleanup(); reject(error);});
    child.on('close', code => {cleanup(); if (failure) reject(failure); else if (code !== 0) reject(new RouterError('workspace_git_failed', 'Workspace git operation failed')); else resolveResult(Buffer.concat(chunks));});
  });
}
function fingerprint(entries: Entry[]): string {
  const digest = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    digest.update(JSON.stringify([entry.path, entry.executable, entry.bytes.length]));
    digest.update(entry.bytes);
  }
  return digest.digest('hex');
}
async function readEntry(root: string, path: string, signal?: AbortSignal): Promise<Entry | undefined> {
  signal?.throwIfAborted();
  safePath(path);
  const absolute = join(root, path);
  try {
    await noSymlinks(absolute, signal);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.nlink !== 1) fail('workspace_file_unsafe', 'Only independent regular files may enter a workspace');
    const bytes = await readFile(absolute, {signal});
    // Recheck after reading to catch straightforward path replacement races.
    await noSymlinks(absolute, signal);
    const after = await lstat(absolute);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== bytes.length || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) fail('workspace_changed', 'Workspace source changed during capture');
    return {path, bytes, executable: Boolean(stat.mode & 0o111)};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function limits(entries: Entry[], maxFiles: number, maxBytes: number): void {
  if (entries.length > maxFiles || entries.reduce((total, entry) => total + entry.bytes.length, 0) > maxBytes) fail('workspace_limit', 'Workspace exceeds configured file or byte limit');
}
async function writeEntries(root: string, entries: Entry[], signal?: AbortSignal): Promise<void> {
  for (const entry of entries) {
    signal?.throwIfAborted();
    const path = join(root, entry.path);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, entry.bytes, {flag: 'wx', mode: entry.executable ? 0o700 : 0o600, signal});
    await chmod(path, entry.executable ? 0o700 : 0o600);
  }
}
async function initialize(root: string, entries: Entry[], signal?: AbortSignal): Promise<string> {
  await git(root, ['init', '--quiet', '--template=', '--initial-branch=snapshot'], undefined, signal);
  await writeEntries(root, entries, signal);
  await git(root, ['add', '--force', '--all', '--', '.'], undefined, signal);
  await git(root, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Captured workspace baseline'], undefined, signal);
  return (await git(root, ['rev-parse', '--verify', 'HEAD'], undefined, signal)).toString('utf8').trim();
}
async function scan(root: string, maxFiles: number, maxBytes: number, gitOnly = false, signal?: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = [];
  let bytes = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    signal?.throwIfAborted();
    for (const item of await readdir(directory, {withFileTypes: true})) {
      signal?.throwIfAborted();
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      safePath(path);
      if (!gitOnly && path === '.git') continue;
      if (!gitOnly && protectedWorkspacePath(path)) fail('workspace_protected_path', 'Worker wrote a protected workspace path');
      const absolute = join(directory, item.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) fail('workspace_symlink', 'Worker workspace contains a symlink');
      if (stat.isDirectory()) await walk(absolute, path);
      else {
        if (!stat.isFile() || stat.nlink !== 1) fail('workspace_file_unsafe', 'Worker workspace contains an unsafe file');
        bytes += stat.size;
        if (entries.length + 1 > maxFiles || bytes > maxBytes) fail('workspace_limit', 'Workspace exceeds configured file or byte limit');
        const entry = await readEntry(root, path, signal);
        if (!entry) fail('workspace_changed', 'Worker workspace changed during verification');
        entries.push(entry);
      }
    }
  }
  await noSymlinks(root, signal);
  await walk(root, '');
  return entries;
}
async function gitFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  return fingerprint(await scan(join(root, '.git'), 20_000, 256 * 1024 * 1024, true, signal));
}

/** Authorize a workspace without creating a snapshot or contacting a model/provider. */
export async function preflightWorkspace(request: WorkspaceRequest, policy: WorkspacePolicy, signal?: AbortSignal): Promise<{sourceRoot: string; maxFiles: number; maxBytes: number}> {
  signal?.throwIfAborted();
  if (!request || !['patch', 'read-only'].includes(request.mode) || !isAbsolute(request.root)) fail('workspace_invalid', 'Workspace must be an absolute local repository path');
  const maxFiles = policy.maxFiles ?? 5_000;
  const maxBytes = policy.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('workspace_invalid', 'Workspace limits must be positive integers');
  await noSymlinks(request.root, signal);
  const sourceRoot = await realpath(request.root);
  let allowed = false;
  for (const root of policy.roots) {
    signal?.throwIfAborted();
    if (!isAbsolute(root)) continue;
    await noSymlinks(root, signal);
    if (inside(await realpath(root), sourceRoot)) {allowed = true; break;}
  }
  if (!allowed) fail('workspace_root_denied', 'Workspace is outside trusted local roots');
  if ((await git(sourceRoot, ['rev-parse', '--show-toplevel'], undefined, signal)).toString('utf8').trim() !== sourceRoot) fail('workspace_invalid', 'Workspace root must be the repository root');
  if (request.includeUntracked !== undefined && (!Array.isArray(request.includeUntracked) || request.includeUntracked.some(path => typeof path !== 'string'))) fail('workspace_invalid', 'Explicit file inclusions must be relative paths');
  for (const path of request.includeUntracked ?? []) {
    signal?.throwIfAborted();
    safePath(path);
    if (protectedWorkspacePath(path)) fail('workspace_protected_path', 'Cannot explicitly capture protected files');
    await noSymlinks(join(sourceRoot, path), signal);
    const stat = await lstat(join(sourceRoot, path));
    if (!stat.isFile() || stat.nlink !== 1) fail('workspace_file_unsafe', 'Only independent regular files may enter a workspace');
    if (stat.size > maxBytes) fail('workspace_limit', 'Workspace exceeds configured byte limit');
  }
  signal?.throwIfAborted();
  return {sourceRoot, maxFiles, maxBytes};
}

/** Capture current tracked content, including dirty edits/deletions, without writing to the source. */
export async function prepareWorkspace(request: WorkspaceRequest, runDirectory: string, policy: WorkspacePolicy, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  if (!isAbsolute(runDirectory)) fail('workspace_invalid', 'Run directory must be an absolute local path');
  const {sourceRoot, maxFiles, maxBytes} = await preflightWorkspace(request, policy, signal);
  if (inside(sourceRoot, resolve(runDirectory))) fail('workspace_run_directory', 'Run directory must be outside the source repository');
  // Parent must already exist. Verify it before any recursive mkdir can follow a link.
  await noSymlinks(dirname(runDirectory), signal);
  await mkdir(runDirectory, {recursive: true, mode: 0o700});
  await noSymlinks(runDirectory, signal);
  const canonicalRun = await realpath(runDirectory);
  if (inside(sourceRoot, canonicalRun)) fail('workspace_run_directory', 'Run directory must be outside the source repository');
  const paths = (await git(sourceRoot, ['ls-files', '--cached', '-z'], undefined, signal)).toString('utf8').split('\0').filter(Boolean);
  const requested = request.includeUntracked ?? [];
  for (const path of requested) {safePath(path); if (protectedWorkspacePath(path)) fail('workspace_protected_path', 'Cannot explicitly capture protected files');}
  const entries: Entry[] = [];
  let bytes = 0;
  for (const path of [...new Set([...paths, ...requested])].sort()) {
    signal?.throwIfAborted();
    safePath(path);
    if (protectedWorkspacePath(path)) continue;
    const stat = await lstat(join(sourceRoot, path)).catch(error => {if (error.code === 'ENOENT') return undefined; throw error;});
    if (stat && (entries.length + 1 > maxFiles || bytes + stat.size > maxBytes)) fail('workspace_limit', 'Workspace exceeds configured file or byte limit');
    const entry = await readEntry(sourceRoot, path, signal);
    if (!entry) {if (requested.includes(path)) fail('workspace_file_missing', 'Explicitly included file does not exist'); continue;}
    bytes += entry.bytes.length;
    entries.push(entry);
    limits(entries, maxFiles, maxBytes);
  }
  const root = join(canonicalRun, 'workspace');
  await mkdir(root, {mode: 0o700});
  try {
    const commit = await initialize(root, entries, signal);
    const baselineFingerprint = fingerprint(entries);
    const snapshot: WorkspaceSnapshot = {root, sourceRoot, mode: request.mode, baselineFingerprint};
    states.set(snapshot, {root, runDirectory: canonicalRun, commit, fingerprint: baselineFingerprint, baseline: entries, gitFingerprint: await gitFingerprint(root, signal), maxFiles, maxBytes, mode: request.mode});
    return snapshot;
  } catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
}

/** Produce a verified review artifact; never apply it to the user's repository. */
export async function collectPatch(snapshot: WorkspaceSnapshot, runDirectory: string, signal?: AbortSignal): Promise<WorkspacePatch> {
  signal?.throwIfAborted();
  const state = states.get(snapshot);
  if (!state || snapshot.root !== state.root || snapshot.baselineFingerprint !== state.fingerprint || snapshot.mode !== state.mode) fail('workspace_snapshot_invalid', 'Snapshot does not match its trusted captured baseline');
  await noSymlinks(runDirectory, signal);
  if (await realpath(runDirectory) !== state.runDirectory) fail('workspace_run_directory', 'Patch output must use the original run directory');
  if (await gitFingerprint(state.root, signal) !== state.gitFingerprint) fail('workspace_baseline_tampered', 'Worker changed snapshot git metadata');
  const current = await scan(state.root, state.maxFiles, state.maxBytes, false, signal);
  const before = new Map(state.baseline.map(entry => [entry.path, entry]));
  const after = new Map(current.map(entry => [entry.path, entry]));
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const a = before.get(path); const b = after.get(path);
    return !a || !b || a.executable !== b.executable || !a.bytes.equals(b.bytes);
  }).sort();
  if (!changedFiles.length) fail('patch_empty', 'Worker produced no workspace changes');
  if (state.mode === 'read-only') fail('workspace_read_only_violation', 'Read-only worker modified the workspace');
  await git(state.root, ['add', '--force', '--all', '--', '.'], undefined, signal);
  const patch = await git(state.root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', state.commit, '--'], state.maxBytes * 3 + 1024 * 1024, signal);
  if (!patch.length) fail('patch_empty', 'Worker produced no applicable patch');
  // Verify against the actual captured content, including the source's pre-existing dirty edits.
  const verificationRoot = await mkdtemp(join(tmpdir(), 'harnessrouter-patch-check-'));
  try {
    await initialize(verificationRoot, state.baseline, signal);
    const verificationPatch = join(verificationRoot, '.git', 'candidate.patch');
    await writeFile(verificationPatch, patch, {flag: 'wx', mode: 0o600, signal});
    await git(verificationRoot, ['apply', '--check', '--binary', '--', verificationPatch], undefined, signal);
  } catch {signal?.throwIfAborted(); fail('patch_not_applicable', 'Patch does not apply to the captured baseline');}
  finally {await rm(verificationRoot, {recursive: true, force: true});}
  // Verification reads must not race another worker edit before emitting artifacts.
  if (fingerprint(await scan(state.root, state.maxFiles, state.maxBytes, false, signal)) !== fingerprint(current)) fail('workspace_changed', 'Worker workspace changed while collecting patch');
  const path = join(state.runDirectory, 'workspace.patch');
  const sha256 = hash(patch);
  signal?.throwIfAborted();
  await writeFile(path, patch, {flag: 'wx', mode: 0o600, signal});
  await writeFile(join(state.runDirectory, 'workspace-changes.json'), JSON.stringify({changedFiles, baselineFingerprint: state.fingerprint, sha256}, null, 2) + '\n', {flag: 'wx', mode: 0o600, signal});
  signal?.throwIfAborted();
  return {path, changedFiles, baselineFingerprint: state.fingerprint, sha256};
}
