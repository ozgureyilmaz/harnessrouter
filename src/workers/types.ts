import type {Cost, UsageRecord, Health} from '../domain/types.js';

export type WorkerKind = 'codex' | 'claude-code' | 'opencode' | 'pi';
export interface WorkerProfile {
  id: string;
  adapter: WorkerKind;
  enabled: boolean;
  model: string;
  /** Only an executable path/name; never a shell command. */
  executable?: string;
  priority?: number;
  timeoutMs?: number;
  allowUnknownCost?: boolean;
  /** Explicit opt-in to spawning this harness, including from a same-kind host. */
  allowExecution: boolean;
  provider?: string;
  /** Physical model identifiers permitted when the configured model is an alias. */
  allowedModels?: string[];
  /**
   * Codex only. Omitted and `cli` keep `codex exec`.
   * `app-server` speaks the stdio app-server protocol for this profile.
   */
  codexTransport?: 'cli' | 'app-server';
}
export interface WorkerInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Prompts go through stdin when the runtime supports it. */
  stdin?: string;
  /** Keep RPC input open until the actual terminal event is observed. */
  closeStdinOnEvent?: string;
}
/** Bidirectional stdio for one run. The process supervisor still owns the lifetime. */
export interface WorkerStdioSession {
  /** First stdin payload. The pipe stays open. */
  readonly opening: string;
  /** Next stdin payload for this server record, if the client has something to say. */
  respond(record: Record<string, unknown>): string | undefined;
  /** Line to write on cancellation before the process is killed. */
  interrupt(): string | undefined;
  /** Set when the server asked for something this client refuses. */
  readonly failure?: {code: string; message: string};
}
export interface WorkerCompletion {
  text: string;
  model?: string;
  reportedModel?: string;
  sessionId?: string;
  cost: Cost;
  usage?: UsageRecord[];
}
/** Protocols are trusted application code, never imported from task input. */
export interface WorkerProtocol {
  kind: WorkerKind;
  requiredHelpFlags: string[];
  helpArgs?: string[];
  probe?(profile: WorkerProfile, options?: {signal?: AbortSignal}): Promise<Health>;
  invocation(profile: WorkerProfile, options: {
    cwd: string; prompt: string; mode: 'read-only' | 'patch'; runDirectory: string; signal?: AbortSignal;
  }): Promise<WorkerInvocation>;
  /** Present when this run speaks a session instead of a one-shot stdin blob. */
  stdioSession?(profile: WorkerProfile, options: {
    cwd: string; prompt: string; mode: 'read-only' | 'patch';
  }): WorkerStdioSession | undefined;
  parse(records: Record<string, unknown>[], profile: WorkerProfile): WorkerCompletion;
}
