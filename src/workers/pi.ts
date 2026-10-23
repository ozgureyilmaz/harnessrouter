import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {normalizePiUsage} from '../observability/metering.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {WorkerCompletion, WorkerProfile, WorkerProtocol} from './types.js';

function object(value: unknown): Record<string, unknown> {return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};}
export const piProtocol: WorkerProtocol = {
  kind: 'pi', requiredHelpFlags: [],
  async probe(profile, options = {}) {
    options.signal?.throwIfAborted();
    try {
      const sdk = await import('@earendil-works/pi-coding-agent');
      options.signal?.throwIfAborted();
      const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
      const pkg = JSON.parse(await readFile(new URL('../package.json', pathToFileURL(entry)), {encoding: 'utf8', signal: options.signal})) as {version: string};
      options.signal?.throwIfAborted();
      if (pkg.version !== '1.1.0' || typeof sdk.ModelRuntime?.create !== 'function' || typeof sdk.createAgentSessionFromServices !== 'function' || typeof sdk.createAgentSessionRuntime !== 'function' || typeof sdk.runRpcMode !== 'function' || typeof sdk.createReadToolDefinition !== 'function') throw new Error('SDK mismatch');
      if (!profile.provider) return {available: false, reason: 'Pi requires explicit provider and model; no native model fallback'};
      if (profile.executable) return {available: false, reason: 'Pi uses the pinned SDK bootstrap; executable overrides are unsupported'};
      return {available: true, modelId: profile.model, provider: profile.provider};
    } catch {options.signal?.throwIfAborted();return {available: false, reason: 'Pinned Pi SDK 1.1.0 or required full-control exports unavailable'};}
  },
  async invocation(profile, options) {
    options.signal?.throwIfAborted();
    if (profile.mcpServers?.length) throw new Error('WORKER_PROTOCOL_ERROR: Pi does not accept additional MCP servers');
    if (!profile.provider || profile.executable) throw new Error('WORKER_PROTOCOL_ERROR: Pi requires provider/model and pinned SDK bootstrap');
    const bootstrap = fileURLToPath(new URL('./pi-bootstrap.js', import.meta.url));
    const sourceMode = import.meta.url.endsWith('.ts');
    const configPath = join(options.runDirectory, 'pi-bootstrap.json');
    await writeFile(configPath, JSON.stringify({cwd: options.cwd, mode: options.mode, runDirectory: options.runDirectory, provider: profile.provider, model: profile.model}), {mode: 0o600, flag: 'wx', signal: options.signal});
    options.signal?.throwIfAborted();
    const args = sourceMode ? ['--import', import.meta.resolve('tsx'), bootstrap.replace(/\.js$/, '.ts')] : [bootstrap];
    return {command: process.execPath, args: [...args, '--config', configPath],
      stdin: `${JSON.stringify({id: 'task', type: 'prompt', message: options.prompt})}\n`,
      closeStdinOnEvent: 'agent_end', env: {PI_SKIP_VERSION_CHECK: '1'},
    };
  },
  parse(records, profile): WorkerCompletion {
    if (records.some((record) => record.type === 'worker_error' || record.type === 'error' || (record.type === 'response' && record.success === false))) throw new Error('WORKER_EXECUTION_FAILED: Pi runtime reported an error');
    if (!records.some((record) => record.type === 'response' && record.id === 'task' && record.command === 'prompt' && record.success === true)) throw new Error('WORKER_PROTOCOL_ERROR: missing successful Pi RPC prompt response');
    if (!records.some((record) => record.type === 'agent_end')) throw new Error('WORKER_PROTOCOL_ERROR: missing Pi agent_end');
    const messages = records.filter((record) => record.type === 'message_end').map((record) => object(record.message)).filter((message) => message.role === 'assistant');
    if (!messages.length) throw new Error('WORKER_PROTOCOL_ERROR: missing Pi assistant completion');
    for (const message of messages) {
      if (['error', 'aborted', 'pending', 'deferred'].includes(String(message.stopReason))) throw new Error('WORKER_EXECUTION_FAILED: Pi did not complete');
      if (message.provider !== profile.provider || message.model !== profile.model) throw new Error('WORKER_PROTOCOL_ERROR: Pi model does not match profile');
    }
    const last = messages.at(-1)!;
    if (last.stopReason !== 'stop') throw new Error('WORKER_EXECUTION_FAILED: Pi final message did not stop normally');
    const text = (Array.isArray(last.content) ? last.content : []).map(object).filter((part) => part.type === 'text').map((part) => typeof part.text === 'string' ? part.text : '').join('\n');
    if (!text.trim()) throw new Error('WORKER_PROTOCOL_ERROR: Pi empty final response');
    return {text, reportedModel:profile.model, model: profile.model, sessionId: records.map((r) => r.sessionId).find((id): id is string => typeof id === 'string'),
      cost: {status: 'unknown', details: 'Pi catalog token estimates are not native-account billing, including OAuth.'},
      usage: [...messages.reduce((unique, message, index) => {
        const id = typeof message.responseId === 'string' ? `id:${message.responseId}` : `event:${index}`;
        const previous = unique.get(id);
        unique.set(id, {...previous, ...message, usage: {...object(previous?.usage), ...object(message.usage)}});
        return unique;
      }, new Map<string, Record<string, unknown>>()).values()].map((message) => normalizePiUsage({
        provider: profile.provider!, model: profile.model, source: 'pi.message_end.canonical_v1', counters: message.usage,
      })),
    };
  },
};
export const PiProtocol = piProtocol;

export const piWorker = piProtocol;
