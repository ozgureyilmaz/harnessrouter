import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {collectPatch, prepareWorkspace} from '../../src/workspace/snapshot.js';

const run = promisify(execFile);
async function git(root: string, ...args: string[]) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {cwd: root, env: {...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost'}});
}
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'harnessrouter-workspace-test-')));
  t.after(() => rm(base, {recursive: true, force: true}));
  const source = join(base, 'source'); const runs = join(base, 'runs');
  await mkdir(source); await mkdir(runs);
  await git(source, 'init', '--quiet', '--template=');
  await writeFile(join(source, 'a.txt'), 'original\n');
  await writeFile(join(source, 'deleted.txt'), 'remove before capture\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Fixture');
  return {base, source, runs, policy: {roots: [source]}};
}

test('local-only: captures dirty tracked baseline, deletions and only explicit untracked files; binary patch applies', async t => {
  const {source, runs, policy} = await fixture(t);
  await writeFile(join(source, 'a.txt'), 'existing dirty edit\n');
  await rm(join(source, 'deleted.txt'));
  await writeFile(join(source, 'included.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(source, 'private-untracked.txt'), 'not requested');
  const before = (await git(source, 'status', '--porcelain=v1', '-z')).stdout;
  const snapshot = await prepareWorkspace({root: source, mode: 'patch', includeUntracked: ['included.bin']}, join(runs, 'first'), policy);
  assert.equal(await readFile(join(snapshot.root, 'a.txt'), 'utf8'), 'existing dirty edit\n');
  await assert.rejects(lstat(join(snapshot.root, 'deleted.txt')), {code: 'ENOENT'});
  await assert.rejects(lstat(join(snapshot.root, 'private-untracked.txt')), {code: 'ENOENT'});
  await writeFile(join(snapshot.root, 'a.txt'), 'worker edit\n');
  await writeFile(join(snapshot.root, 'included.bin'), Buffer.from([0, 9, 2, 255]));
  await writeFile(join(snapshot.root, 'new.txt'), 'new worker file\n');
  const patch = await collectPatch(snapshot, join(runs, 'first'));
  assert.deepEqual(patch.changedFiles, ['a.txt', 'included.bin', 'new.txt']);
  const patchBytes = await readFile(patch.path);
  assert.match(patchBytes.toString(), /GIT binary patch/);
  assert.equal(patch.sha256, createHash('sha256').update(patchBytes).digest('hex'));
  const manifest = JSON.parse(await readFile(join(runs, 'first', 'workspace-changes.json'), 'utf8'));
  assert.deepEqual(manifest.changedFiles, patch.changedFiles);
  const untouched = await prepareWorkspace({root: source, mode: 'patch', includeUntracked: ['included.bin']}, join(runs, 'verification'), policy);
  await git(untouched.root, 'apply', '--check', '--binary', patch.path);
  await git(untouched.root, 'apply', '--binary', patch.path);
  assert.equal(await readFile(join(untouched.root, 'a.txt'), 'utf8'), 'worker edit\n');
  assert.equal((await git(source, 'status', '--porcelain=v1', '-z')).stdout, before);
  assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), 'existing dirty edit\n');
});

test('local-only: excludes tracked secrets, harness instructions and executable control configuration', async t => {
  const {source, runs, policy} = await fixture(t);
  for (const path of ['.env', '.env.local', 'credentials.json', '.mcp.json', '.claude.json', 'opencode.json', 'opencode.jsonc', 'SYSTEM.md', 'AGENTS.md', '.claude/settings.json', '.pi/extensions/evil.ts', '.codex/config.toml', '.opencode/plugin.ts', 'hooks/pre-run.sh', 'node_modules/dependency/index.js']) {
    await mkdir(join(source, path, '..'), {recursive: true});
    await writeFile(join(source, path), 'must never be exposed');
  }
  await git(source, 'add', '--force', '.');
  const snapshot = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'one'), policy);
  assert.deepEqual((await git(snapshot.root, 'ls-files')).stdout.trim().split('\n'), ['a.txt', 'deleted.txt']);
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch', includeUntracked: ['.env']}, join(runs, 'two'), policy), {code: 'workspace_protected_path'});
});

test('local-only: denies untrusted roots, traversal, absolute includes, symlinks and parent symlinks', async t => {
  const {base, source, runs, policy} = await fixture(t);
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'denied'), {roots: [runs]}), {code: 'workspace_root_denied'});
  for (const include of ['../outside', '/etc/passwd', 'nested/../a.txt', 'C:\\private', 'a\\b']) {
    await assert.rejects(prepareWorkspace({root: source, mode: 'patch', includeUntracked: [include]}, join(runs, 'unsafe'), policy), {code: 'workspace_path_unsafe'});
  }
  await writeFile(join(base, 'outside'), 'outside');
  await symlink(join(base, 'outside'), join(source, 'link'));
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch', includeUntracked: ['link']}, join(runs, 'link'), policy), {code: 'workspace_symlink'});
  await symlink(base, join(source, 'parent'));
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch', includeUntracked: ['parent/outside']}, join(runs, 'parent'), policy), {code: 'workspace_symlink'});
  await symlink(source, join(base, 'source-link'));
  await assert.rejects(prepareWorkspace({root: join(base, 'source-link'), mode: 'patch'}, join(runs, 'root-link'), policy), {code: 'workspace_symlink'});
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch'}, join(source, 'inside'), policy), {code: 'workspace_run_directory'});
});

test('local-only: enforces file and byte bounds, hashes content and handles empty/read-only outcomes', async t => {
  const {source, runs, policy} = await fixture(t);
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'small'), {...policy, maxBytes: 1}), {code: 'workspace_limit'});
  await assert.rejects(prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'few'), {...policy, maxFiles: 1}), {code: 'workspace_limit'});
  const one = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'one'), policy);
  const two = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'two'), policy);
  assert.equal(one.baselineFingerprint, two.baselineFingerprint);
  await assert.rejects(collectPatch(one, join(runs, 'one')), {code: 'patch_empty'});
  await writeFile(join(source, 'a.txt'), 'changed in source\n');
  const three = await prepareWorkspace({root: source, mode: 'read-only'}, join(runs, 'three'), policy);
  assert.notEqual(one.baselineFingerprint, three.baselineFingerprint);
  await writeFile(join(three.root, 'a.txt'), 'worker modification');
  await assert.rejects(collectPatch(three, join(runs, 'three')), {code: 'workspace_read_only_violation'});
});

test('local-only: rejects baseline tampering, protected writes, symlink output and oversized output', async t => {
  const {base, source, runs, policy} = await fixture(t);
  const tampered = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'tamper'), policy);
  await writeFile(join(tampered.root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  await assert.rejects(collectPatch(tampered, join(runs, 'tamper')), {code: 'workspace_baseline_tampered'});
  const protectedWrite = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'protected'), policy);
  await writeFile(join(protectedWrite.root, '.env'), 'worker secret');
  await assert.rejects(collectPatch(protectedWrite, join(runs, 'protected')), {code: 'workspace_protected_path'});
  const symbolic = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'symbolic'), policy);
  await symlink(join(base, 'outside'), join(symbolic.root, 'new-link'));
  await assert.rejects(collectPatch(symbolic, join(runs, 'symbolic')), {code: 'workspace_symlink'});
  const bounded = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'bounded'), {...policy, maxBytes: 100});
  await writeFile(join(bounded.root, 'large'), 'x'.repeat(101));
  await assert.rejects(collectPatch(bounded, join(runs, 'bounded')), {code: 'workspace_limit'});
});

test('local-only: captures deletions and executable changes in patch without inheriting user git hooks', async t => {
  const {base, source, runs, policy} = await fixture(t);
  const marker = join(base, 'hook-executed');
  const hook = join(source, '.git', 'hooks', 'pre-commit');
  await mkdir(join(source, '.git', 'hooks'), {recursive: true});
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook, 0o700);
  const snapshot = await prepareWorkspace({root: source, mode: 'patch'}, join(runs, 'one'), policy);
  await rm(join(snapshot.root, 'deleted.txt'));
  await chmod(join(snapshot.root, 'a.txt'), 0o700);
  const patch = await collectPatch(snapshot, join(runs, 'one'));
  assert.deepEqual(patch.changedFiles, ['a.txt', 'deleted.txt']);
  assert.match(await readFile(patch.path, 'utf8'), /new mode 100755/);
  await assert.rejects(lstat(marker), {code: 'ENOENT'});
});
