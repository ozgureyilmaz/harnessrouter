import {chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {join, resolve} from 'node:path';
import {runProcess, workerEnvironment} from './process.js';
import {normalizeUsageRecord} from '../observability/metering.js';
import type {WorkerCompletion, WorkerProfile, WorkerProtocol} from './types.js';

function object(value: unknown): Record<string, unknown> {return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};}
function counter(value: unknown): number|undefined {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;}

/** Native tool permissions are deny-by-default. This is a permission policy, not an OS sandbox. */
export function openCodePermissions(cwd: string, mode: 'read-only'|'patch'): Record<string, unknown> {
  const paths = {'*': 'deny', [cwd]: 'allow', [`${cwd}/*`]: 'allow', [`${cwd}/.git`]: 'deny', [`${cwd}/.git/*`]: 'deny', [`${cwd}/**/.git`]: 'deny', [`${cwd}/**/.git/*`]: 'deny'};
  return {'*': 'deny', read: paths, list: paths, glob: paths, grep: paths,
    edit: mode === 'patch' ? paths : 'deny', external_directory: 'deny',
    bash: 'deny', task: 'deny', skill: 'deny', webfetch: 'deny', websearch: 'deny', codesearch: 'deny',
    question: 'deny', plan_enter: 'deny', plan_exit: 'deny'};
}

/** Metadata only: the CLI prints provider labels and credential types, never values. */
export function assertOpenCodeAuthMetadata(output: string): void {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const credentials = /(?:^|\n)[^\n]*?(\d+) credentials?(?:\s|$)/m.exec(plain);
  if (!credentials || /\bwellknown\b/i.test(plain)) throw new Error('WORKER_ISOLATION_UNAVAILABLE: unsupported or unrecognized native auth metadata');
  const beforeCount = plain.slice(0, credentials.index);
  const types = beforeCount.split('\n').filter((line) => /\b(?:api|oauth)\s*$/.test(line));
  if (types.length !== Number(credentials[1])) throw new Error('WORKER_ISOLATION_UNAVAILABLE: native auth type metadata could not be classified');
}

export async function assertNoOpenCodeManagedConfig(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const roots = process.platform === 'darwin' ? ['/Library/Application Support/opencode', '/Library/Managed Preferences/ai.opencode.managed.plist', join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist')]
    : process.platform === 'win32' ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'opencode')] : ['/etc/opencode'];
  for (const path of roots) {
    signal?.throwIfAborted();
    try { await lstat(path); } catch (error) { signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    signal?.throwIfAborted();
    throw new Error('WORKER_ISOLATION_UNAVAILABLE: managed OpenCode configuration is present');
  }
}

/** A native path policy cannot safely contain preexisting symlinks or configuration glob metacharacters. */
export async function assertOpenCodeSnapshot(cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (/[\\*?{}[\]]/.test(cwd)) throw new Error('WORKER_ISOLATION_UNAVAILABLE: unsupported permission path');
  const visit = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(path, {withFileTypes: true});
    signal?.throwIfAborted();
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === '.git') continue;
      if (entry.isSymbolicLink()) throw new Error('WORKER_ISOLATION_UNAVAILABLE: OpenCode snapshot contains symlink');
      if (entry.isDirectory()) await visit(join(path, entry.name));
    }
  };
  await visit(cwd);
  signal?.throwIfAborted();
}

export async function prepareOpenCodeIsolation(runDirectory: string, cwd: string, mode: 'read-only'|'patch', signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  signal?.throwIfAborted();
  const root = resolve(runDirectory);
  const config = join(root, 'opencode-config', 'opencode');
  await mkdir(config, {recursive: true});
  signal?.throwIfAborted();
  // Npm.install checks directory writability before installing config dependencies (1.18.15).
  // Preexisting .gitignore avoids Config.ensureGitignore writing into this read-only directory.
  await writeFile(join(config, '.gitignore'), '*\n', {flag: 'wx', mode: 0o400, signal});
  signal?.throwIfAborted();
  await chmod(config, 0o500);
  signal?.throwIfAborted();
  return {
    XDG_CONFIG_HOME: join(root, 'opencode-config'), XDG_CACHE_HOME: join(root, 'opencode-cache'), XDG_STATE_HOME: join(root, 'opencode-state'),
    OPENCODE_CONFIG_DIR: config, OPENCODE_TEST_HOME: join(root, 'opencode-home'),
    OPENCODE_DB: join(root, 'opencode-isolated.db'), // no native account/organization or resumed session state
    OPENCODE_CONFIG_CONTENT: JSON.stringify({$schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', plugin: [], mcp: {}, instructions: [], lsp: false, formatter: false, permission: openCodePermissions(cwd, mode)}),
    OPENCODE_PERMISSION: JSON.stringify(openCodePermissions(cwd, mode)),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
  };
}

async function checkOpenCodeMetadata(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const version = await runProcess(command, ['--version'], {cwd, env, timeoutMs: 5000, maxBytes: 256 * 1024, signal});
  signal?.throwIfAborted();
  if (version.stdout.trim() !== '1.18.15') throw new Error('WORKER_PROTOCOL_UNSUPPORTED: OpenCode isolation audited only for 1.18.15');
  const help = await runProcess(command, ['run', '--help'], {cwd, env, timeoutMs: 5000, maxBytes: 256 * 1024, signal});
  signal?.throwIfAborted();
  if (openCodeProtocol.requiredHelpFlags.some((flag) => !help.stdout.includes(flag))) throw new Error('WORKER_PROTOCOL_UNSUPPORTED: missing OpenCode flags');
  const metadata = await runProcess(command, ['auth', 'list'], {cwd, env, timeoutMs: 5000, maxBytes: 256 * 1024, signal});
  signal?.throwIfAborted();
  assertOpenCodeAuthMetadata(metadata.stdout);
}

export const openCodeProtocol: WorkerProtocol = {
  kind: 'opencode', helpArgs: ['run', '--help'], requiredHelpFlags: ['--format', '--model', '--pure', '--dir'],
  async probe(profile, options = {}) {
    options.signal?.throwIfAborted();
    let temporary: string|undefined;
    try {
      await assertNoOpenCodeManagedConfig(options.signal);
      options.signal?.throwIfAborted();
      temporary = await mkdtemp(join(tmpdir(), 'harnessrouter-opencode-probe-'));
      options.signal?.throwIfAborted();
      const env = {...workerEnvironment(), ...await prepareOpenCodeIsolation(temporary, temporary, 'read-only', options.signal)};
      await checkOpenCodeMetadata(profile.executable ?? 'opencode', temporary, env, options.signal);
      return {available: true, modelId: profile.model, provider: profile.provider ?? profile.model.split('/')[0]};
    } catch {options.signal?.throwIfAborted();return {available: false, reason: 'OpenCode 1.18.15 with classifiable native api/oauth auth and no managed config is required'};}
    finally {if (temporary) {await chmod(join(temporary, 'opencode-config', 'opencode'), 0o700).catch(() => {}); await rm(temporary, {recursive: true, force: true});}}
  },
  async invocation(profile, options) {
    options.signal?.throwIfAborted();
    if (!/^[^/\s]+\/.+/.test(profile.model)) throw new Error('WORKER_PROTOCOL_ERROR: OpenCode requires provider/model');
    await assertNoOpenCodeManagedConfig(options.signal);
    await assertOpenCodeSnapshot(options.cwd, options.signal);
    options.signal?.throwIfAborted();
    const env = await prepareOpenCodeIsolation(options.runDirectory, options.cwd, options.mode, options.signal);
    await checkOpenCodeMetadata(profile.executable ?? 'opencode', options.cwd, {...workerEnvironment(), ...env}, options.signal);
    options.signal?.throwIfAborted();
    return {command: profile.executable ?? 'opencode', args: ['run', '--format', 'json', '--pure', '--model', profile.model, '--dir', options.cwd], env, stdin: options.prompt};
  },
  parse(records, profile): WorkerCompletion {
    if (records.some((record) => record.type === 'error')) throw new Error('WORKER_EXECUTION_FAILED: OpenCode reported an error');
    const ends = records.filter((record) => record.type === 'step_finish');
    if (!ends.length || object(ends.at(-1)!.part).reason !== 'stop') throw new Error('WORKER_PROTOCOL_ERROR: OpenCode missing normal final step_finish');
    const sessionIds = new Set(records.map((record) => record.sessionID).filter((id): id is string => typeof id === 'string'));
    if (sessionIds.size !== 1) throw new Error('WORKER_PROTOCOL_ERROR: OpenCode session identity missing or inconsistent');
    const text = records.filter((record) => record.type === 'text').map((record) => object(record.part).text).filter((part): part is string => typeof part === 'string').join('\n');
    if (!text.trim()) throw new Error('WORKER_PROTOCOL_ERROR: OpenCode empty completion');
    const distinct = new Map<string, Record<string, unknown>>();
    ends.forEach((record, index) => {
      const part = object(record.part); const id = typeof part.id === 'string' ? `id:${part.id}` : `event:${index}`;
      const previous = object(distinct.get(id)); const oldTokens = object(previous.tokens); const newTokens = object(part.tokens);
      distinct.set(id, {...previous, ...part, tokens: {...oldTokens, ...newTokens, cache: {...object(oldTokens.cache), ...object(newTokens.cache)}}});
    });
    const usage = [...distinct.values()].map((part) => {
      const tokens = object(part.tokens); const cache = object(tokens.cache);
      const input = counter(tokens.input); const read = counter(cache.read); const write = counter(cache.write);
      const output = counter(tokens.output); const reasoning = counter(tokens.reasoning);
      return normalizeUsageRecord({provider: profile.provider ?? profile.model.split('/')[0]!, model: profile.model,
        source: 'opencode.step_finish.canonical_v1', measurement: 'provider_reported',
        counters: {inputTokens: input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined,
          outputTokens: output !== undefined && reasoning !== undefined ? output + reasoning : undefined,
          cachedInputTokens: read, cacheWriteInputTokens: write, reasoningOutputTokens: reasoning, totalTokens: counter(tokens.total)},
        details: 'OpenCode input excludes cache and output excludes reasoning; canonical counters include those subsets once.',
      });
    });
    // Native run JSON identifies no physical model; report configured model, not a measured model claim.
    return {text, model: profile.model, sessionId: [...sessionIds][0], usage,
      cost: {status: 'unknown', details: 'OpenCode native-account billing cannot be verified from step_finish catalog cost.'}};
  },
};
export const OpenCodeProtocol = openCodeProtocol;

export const openCodeWorker = openCodeProtocol;
