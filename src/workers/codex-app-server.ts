import type {WorkerCompletion, WorkerProfile, WorkerStdioSession} from './types.js';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function sandbox(mode: 'read-only' | 'patch', cwd: string): {sandbox: string; sandboxPolicy: Record<string, unknown>} {
  if (mode === 'patch') return {sandbox: 'workspaceWrite', sandboxPolicy: {type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false}};
  return {sandbox: 'readOnly', sandboxPolicy: {type: 'readOnly'}};
}

/**
 * Narrow Codex App Server client. It starts one new thread and one turn.
 * It never sends thread/resume. It never approves a server request.
 */
export class CodexAppServerSession implements WorkerStdioSession {
  private threadId?: string;
  private turnId?: string;
  private initialized = false;
  private turnSent = false;
  failure?: {code: string; message: string};
  readonly opening: string;
  constructor(private readonly profile: WorkerProfile, private readonly options: {cwd: string; prompt: string; mode: 'read-only' | 'patch'}) {
    this.opening = line({method: 'initialize', id: 1, params: {clientInfo: {name: 'harnessrouter', title: 'harnessrouter', version: '1.0.0'}}});
  }
  respond(recordValue: Record<string, unknown>): string | undefined {
    if (this.failure) return undefined;
    const method = text(recordValue.method);
    const id = typeof recordValue.id === 'number' ? recordValue.id : undefined;
    if (recordValue.error) {
      this.failure = {code: 'worker_protocol_unsupported', message: 'Codex app-server returned an error'};
      return undefined;
    }
    if (method && id !== undefined && recordValue.result === undefined) {
      this.failure = {code: 'permission_required', message: 'Codex app-server asked for an approval, which harnessrouter does not grant'};
      return line({id, error: {code: -32000, message: 'approval denied'}});
    }
    if (!this.initialized && id === 1 && recordValue.result) {
      this.initialized = true;
      const policy = sandbox(this.options.mode, this.options.cwd);
      return line({method: 'initialized', params: {}}) + line({method: 'thread/start', id: 2, params: {model: this.profile.model, cwd: this.options.cwd, approvalPolicy: 'never', sandbox: policy.sandbox, serviceName: 'harnessrouter'}});
    }
    if (id === 2 && recordValue.result) {
      const thread = record(record(recordValue.result)?.thread);
      const threadId = text(thread?.id);
      if (!threadId) {
        this.failure = {code: 'worker_protocol_unsupported', message: 'Codex app-server did not return a thread id'};
        return undefined;
      }
      this.threadId = threadId;
      return this.startTurn();
    }
    if (method === 'thread/started') {
      const threadId = text(record(record(recordValue.params)?.thread)?.id);
      if (threadId) this.threadId = threadId;
      return this.startTurn();
    }
    if (method === 'turn/started') this.turnId = text(record(record(recordValue.params)?.turn)?.id) ?? this.turnId;
    return undefined;
  }
  interrupt(): string | undefined {
    if (!this.threadId || !this.turnId) return undefined;
    return line({method: 'turn/interrupt', id: 4, params: {threadId: this.threadId, turnId: this.turnId}});
  }
  private startTurn(): string | undefined {
    if (!this.threadId || this.turnSent || this.failure) return undefined;
    this.turnSent = true;
    const policy = sandbox(this.options.mode, this.options.cwd);
    return line({method: 'turn/start', id: 3, params: {threadId: this.threadId, input: [{type: 'text', text: this.options.prompt}], cwd: this.options.cwd, approvalPolicy: 'never', model: this.profile.model, sandboxPolicy: policy.sandboxPolicy}});
  }
}

export function parseCodexAppServer(records: Record<string, unknown>[], profile: WorkerProfile): WorkerCompletion {
  let answer: string | undefined;
  let threadId: string | undefined;
  let reportedModel: string | undefined;
  let terminal: string | undefined;
  for (const event of records) {
    if (event.method === 'thread/resume') throw new Error('Codex app-server client must not resume a thread');
    const result = record(event.result);
    const thread = record(result?.thread);
    if (event.id === 2 && text(thread?.id)) threadId = text(thread?.id);
    if (event.method === 'model/rerouted') {
      const model = text(record(event.params)?.toModel);
      if (model && model !== profile.model && !profile.allowedModels?.includes(model)) throw new Error('Codex app-server reported a model outside the configured allowlist');
      reportedModel = model ?? reportedModel;
    }
    if (event.method === 'item/completed') {
      const item = record(record(event.params)?.item);
      if (item?.type === 'agentMessage' && item.phase !== 'commentary') answer = text(item.text) ?? answer;
    }
    if (event.method === 'turn/completed') terminal = text(record(record(event.params)?.turn)?.status);
    if (event.error || event.method === 'error') throw new Error('Codex app-server returned an error');
  }
  if (terminal === 'interrupted') throw new Error('Codex app-server turn was interrupted');
  if (terminal === 'failed') throw new Error('Codex app-server turn failed');
  if (terminal !== 'completed') throw new Error('Codex app-server ended without turn/completed');
  if (!answer?.trim()) throw new Error('Codex app-server completed without a final assistant message');
  return {text: answer, model: reportedModel ?? profile.model, reportedModel, sessionId: threadId, cost: {status: 'unknown', details: 'Codex app-server does not report a reliable per-run USD charge'}, usage: []};
}
