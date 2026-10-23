import type {Cost, UsageRecord, Health} from '../domain/types.js';

export type WorkerKind = 'codex' | 'claude-code' | 'opencode' | 'pi';
/** One local stdio MCP server. No environment, URL, or headers. */
export interface WorkerMcpServer {
  name: string;
  command: string;
  args?: string[];
}
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
  /** Loopback OpenAI-compatible base URL for the Pi adapter, such as Ollama's /v1 endpoint. */
  baseUrl?: string;
  /** Optional decision-model hint. The built-in adapter sentence is used when this is omitted. */
  description?: string;
  /** Physical model identifiers permitted when the configured model is an alias. */
  allowedModels?: string[];
  /** Explicit stdio MCP servers. Omitted means none are forwarded. */
  mcpServers?: WorkerMcpServer[];
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
    /** Workspace MCP tools for a named route profile. Omitted on the default worker route. */
    enabledTools?: readonly string[];
  }): Promise<WorkerInvocation>;
  parse(records: Record<string, unknown>[], profile: WorkerProfile): WorkerCompletion;
}
