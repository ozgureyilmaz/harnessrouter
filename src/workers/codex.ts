import {normalizeUsageRecord} from '../observability/metering.js';
import type {Cost, UsageRecord} from '../domain/types.js';
import {CodexAppServerSession, parseCodexAppServer} from './codex-app-server.js';
import {codexMcpServersArg} from './mcp-allowlist.js';
import type {WorkerProfile, WorkerProtocol} from './types.js';

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Trusted adapter for the native Codex CLI. JSONL records are always treated as untrusted. */
export const codexWorker: WorkerProtocol = {
  kind: 'codex',
  helpArgs: ['exec', '--help'],
  requiredHelpFlags: ['--json', '--ignore-user-config', '--ephemeral', '--sandbox', '--model', '--strict-config'],
  async invocation(profile: WorkerProfile, {cwd, prompt, mode, signal}) {
    signal?.throwIfAborted();
    if (!profile.model.trim()) throw new Error('Codex worker requires an explicit model');
    if (profile.codexTransport === 'app-server') return {command: profile.executable ?? 'codex', args: ['app-server', '--listen', 'stdio://']};
    return {
      command: profile.executable ?? 'codex',
      args: ['exec', '--json', '--ignore-user-config', '--ephemeral', '--strict-config',
        '--sandbox', mode === 'patch' ? 'workspace-write' : 'read-only', '--model', profile.model,
        '-C', cwd, '-c', codexMcpServersArg(profile.mcpServers), '-c', 'features.multi_agent=false', '-'],
      stdin: prompt,
    };
  },
  stdioSession(profile, options) {
    if (profile.codexTransport !== 'app-server') return undefined;
    return new CodexAppServerSession(profile, options);
  },
  parse(records: Record<string, unknown>[], profile: WorkerProfile) {
    if (profile.codexTransport === 'app-server') return parseCodexAppServer(records, profile);
    let finalText: string | undefined;
    let model: string | undefined;
    let sessionId: string | undefined;
    const usages: UsageRecord[] = [];
    const turns = new Map<string, {index: number; counters: Record<string, unknown>}>();
    let terminal = false;
    for (const event of records) {
      const type = str(event.type);
      const payload = obj(event);
      if (!type || !payload) throw new Error('Malformed Codex JSONL event');
      if (type === 'thread.started') sessionId = str(payload.thread_id) ?? sessionId;
      if (type === 'turn.failed') throw new Error('Codex worker reported a failed turn');
      if (type === 'error') throw new Error('Codex worker reported an error');
      if (type === 'item.completed') {
        const item = obj(payload.item);
        if (item?.type === 'agent_message') finalText = str(item.text) ?? finalText;
      }
      if (type === 'turn.completed') {
        terminal = true;
        const turn = obj(payload.turn);
        const m = str(turn?.model);
        if(m&&m!==profile.model&&!profile.allowedModels?.includes(m))throw new Error('Codex reported a model outside the configured allowlist');
        model = m ?? model;
        const raw = obj(turn?.usage) ?? obj(payload.usage) ?? {};
        const id = str(turn?.id) ?? str(payload.turn_id);
        const previous = id ? turns.get(id) : undefined;
        const counters = {...previous?.counters};
        for (const [key, value] of Object.entries(raw)) if (value !== undefined && value !== null) counters[key] = value;
        const usage = normalizeUsageRecord({provider: 'openai', model: m ?? profile.model, source: 'codex_cli_turn_usage.canonical_v1', measurement: 'provider_reported', counters});
        if (previous) usages[previous.index] = usage;
        else usages.push(usage);
        if (id) turns.set(id, {index: previous?.index ?? usages.length - 1, counters});
      }
    }
    if(model&&model!==profile.model&&!profile.allowedModels?.includes(model))throw new Error('Codex reported a model outside the configured allowlist');
    if (!terminal) throw new Error('Codex JSONL ended without turn.completed');
    if (!finalText?.trim()) throw new Error('Codex worker completed without a final assistant message');
    const cost: Cost = {status: 'unknown', details: 'Codex CLI does not report a reliable per-run USD charge'};
    return {text: finalText, model: model ?? profile.model, reportedModel:model, sessionId, cost, usage: usages};
  },
};
