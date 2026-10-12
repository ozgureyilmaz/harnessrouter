import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';

export type PiRpcRecord = Record<string, unknown> & { type: string; id?: string };

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxRecordBytes?: number;
  maxOutputBytes?: number;
  shutdownTimeoutMs?: number;
}

export interface PiRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PiRpcError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) {
    super(message);
    this.name = 'PiRpcError';
  }
}

interface PendingRequest {
  resolve(record: PiRpcRecord): void;
  reject(error: Error): void;
  cleanup(): void;
}

function isRecord(value: unknown): value is PiRpcRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string';
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PiRpcError(message, 'PI_RPC_TIMEOUT', true)), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class PiRpcClient extends EventEmitter {
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventWaiters = new Set<(error: Error) => void>();
  private readonly maxRecordBytes: number;
  private readonly maxOutputBytes: number;
  private readonly shutdownTimeoutMs: number;
  private pendingBytes = Buffer.alloc(0);
  private totalOutputBytes = 0;
  private stderrBytes = 0;
  private startupPromise?: Promise<void>;
  private exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private stopping = false;
  private lastAssistantMessage?: unknown;
  private readonly completedToolCalls: Array<{ name: string; failed: boolean; durationMs?: number }> = [];

  constructor(private readonly options: PiRpcClientOptions) {
    super();
    this.maxRecordBytes = options.maxRecordBytes ?? 2 * 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 12 * 1024 * 1024;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
  }

  get finalAssistantMessage(): unknown {
    return this.lastAssistantMessage;
  }

  get toolCalls(): ReadonlyArray<{ name: string; failed: boolean; durationMs?: number }> {
    return this.completedToolCalls;
  }

  get stderrByteCount(): number {
    return this.stderrBytes;
  }

  async start(options: PiRpcRequestOptions = {}): Promise<void> {
    if (this.child) return;
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.spawnProcess(options);
    return this.startupPromise;
  }

  async request(
    type: string,
    params: Record<string, unknown> = {},
    options: PiRpcRequestOptions = {},
  ): Promise<PiRpcRecord> {
    await this.start(options);
    options.signal?.throwIfAborted();
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new PiRpcError('Pi RPC process is not accepting commands.', 'PI_RPC_CLOSED');
    }
    const id = randomUUID();
    const command = JSON.stringify({ ...params, id, type });
    if (Buffer.byteLength(command) > this.maxRecordBytes) {
      throw new PiRpcError('Pi RPC command exceeds the configured record limit.', 'PI_RPC_COMMAND_TOO_LARGE');
    }

    const response = new Promise<PiRpcRecord>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new PiRpcError('Pi RPC command was cancelled.', 'PI_RPC_CANCELLED'));
      };
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const record = Buffer.from(`${command}\n`, 'utf8');
      if (!child.stdin.write(record)) await once(child.stdin, 'drain');
    } catch {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.cleanup();
      pending?.reject(new PiRpcError('Pi RPC command could not be written.', 'PI_RPC_WRITE_FAILED', true));
    }

    const timeoutMs = options.timeoutMs ?? 10_000;
    const result = await raceTimeout(response, timeoutMs, `Pi RPC ${type} command timed out.`).catch((error) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.cleanup();
      throw error;
    });
    if (result.success === false) {
      throw new PiRpcError(`Pi RPC rejected ${type}.`, 'PI_RPC_COMMAND_REJECTED');
    }
    return result;
  }

  waitForEvent(
    eventType: string,
    options: PiRpcRequestOptions = {},
  ): Promise<PiRpcRecord> {
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise<PiRpcRecord>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let rejectWait: (error: Error) => void;
      const onEvent = (record: PiRpcRecord) => {
        if (record.type !== eventType) return;
        cleanup();
        resolve(record);
      };
      const onAbort = () => {
        rejectWait(new PiRpcError('Pi RPC event wait was cancelled.', 'PI_RPC_CANCELLED'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('record', onEvent);
        options.signal?.removeEventListener('abort', onAbort);
        this.eventWaiters.delete(rejectWait);
      };
      rejectWait = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.on('record', onEvent);
      this.eventWaiters.add(rejectWait);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        rejectWait(new PiRpcError(`Pi RPC did not emit ${eventType}.`, 'PI_RPC_TIMEOUT', true));
      }, timeoutMs);
      timer.unref();
    });
  }

  async abort(): Promise<void> {
    if (!this.child || this.stopping) return;
    try {
      await this.request('abort', {}, { timeoutMs: 750 });
    } catch {
      // The process may already be stopping or have exited.
    }
  }

  async close(): Promise<void> {
    if (!this.child || this.stopping) return;
    this.stopping = true;
    this.rejectEventWaiters(new PiRpcError('Pi RPC process is shutting down.', 'PI_RPC_CLOSED'));
    const child = this.child;
    child.stdin?.end();
    const exited = this.exitPromise ?? Promise.resolve({ code: null, signal: null });
    try {
      await raceTimeout(exited, this.shutdownTimeoutMs, 'Pi RPC shutdown timed out.');
    } catch {
      this.signalProcessGroup('SIGTERM');
      try {
        await raceTimeout(exited, 1_000, 'Pi RPC process did not exit after SIGTERM.');
      } catch {
        this.signalProcessGroup('SIGKILL');
      }
    }
    this.rejectAll(new PiRpcError('Pi RPC process closed.', 'PI_RPC_CLOSED'));
    this.child = undefined;
  }

  private async spawnProcess(options: PiRpcRequestOptions): Promise<void> {
    options.signal?.throwIfAborted();
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.once('error', () => {
      this.rejectAll(new PiRpcError('Pi RPC process could not start.', 'PI_RPC_SPAWN_FAILED'));
    });
    child.once('exit', (code, signal) => {
      if (!this.stopping) {
        this.rejectAll(new PiRpcError('Pi RPC process exited unexpectedly.', 'PI_RPC_EXITED', true));
        this.rejectEventWaiters(new PiRpcError('Pi RPC process exited unexpectedly.', 'PI_RPC_EXITED', true));
      }
      this.emit('exit', { code, signal });
    });
    child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBytes += Buffer.byteLength(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new PiRpcError('Pi RPC process could not start.', 'PI_RPC_SPAWN_FAILED')));
    });
  }

  private consumeStdout(chunk: Buffer): void {
    this.totalOutputBytes += chunk.length;
    if (this.totalOutputBytes > this.maxOutputBytes) {
      this.rejectAll(new PiRpcError('Pi RPC output exceeded the configured limit.', 'PI_RPC_OUTPUT_TOO_LARGE'));
      this.signalProcessGroup('SIGTERM');
      return;
    }
    this.pendingBytes = Buffer.concat([this.pendingBytes, chunk]);
    if (this.pendingBytes.length > this.maxRecordBytes && this.pendingBytes.indexOf(0x0a) < 0) {
      this.rejectAll(new PiRpcError('Pi RPC emitted an oversized record.', 'PI_RPC_RECORD_TOO_LARGE'));
      this.signalProcessGroup('SIGTERM');
      return;
    }

    let newline: number;
    while ((newline = this.pendingBytes.indexOf(0x0a)) >= 0) {
      let line = this.pendingBytes.subarray(0, newline);
      this.pendingBytes = this.pendingBytes.subarray(newline + 1);
      if (line.length > this.maxRecordBytes) {
        this.rejectAll(new PiRpcError('Pi RPC emitted an oversized record.', 'PI_RPC_RECORD_TOO_LARGE'));
        this.signalProcessGroup('SIGTERM');
        return;
      }
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line.toString('utf8'));
      } catch {
        this.rejectAll(new PiRpcError('Pi RPC emitted malformed JSON.', 'PI_RPC_MALFORMED_JSON'));
        this.signalProcessGroup('SIGTERM');
        return;
      }
      if (!isRecord(value)) {
        this.rejectAll(new PiRpcError('Pi RPC record has no event type.', 'PI_RPC_INVALID_RECORD'));
        this.signalProcessGroup('SIGTERM');
        return;
      }
      this.onRecord(value);
    }
    if (this.pendingBytes.length > this.maxRecordBytes) {
      this.rejectAll(new PiRpcError('Pi RPC emitted an oversized record.', 'PI_RPC_RECORD_TOO_LARGE'));
      this.signalProcessGroup('SIGTERM');
    }
  }

  private onRecord(record: PiRpcRecord): void {
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        pending.cleanup();
        pending.resolve(record);
      }
    }
    if (record.type === 'message_end') {
      const message = record.message as { role?: unknown } | undefined;
      if (message?.role === 'assistant') this.lastAssistantMessage = record.message;
    }
    if (record.type === 'agent_end' && Array.isArray(record.messages)) {
      const messages = record.messages as Array<{ role?: unknown }>;
      const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
      if (assistant) this.lastAssistantMessage = assistant;
    }
    if (record.type === 'tool_execution_end' && typeof record.toolName === 'string') {
      this.completedToolCalls.push({
        name: record.toolName,
        failed: record.isError === true,
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
      });
    }
    this.emit('record', record);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectEventWaiters(error: Error): void {
    for (const reject of [...this.eventWaiters]) reject(error);
  }

  private signalProcessGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else this.child?.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}
