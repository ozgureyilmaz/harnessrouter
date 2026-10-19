import type {WorkerKind,WorkerProtocol} from './types.js';
/** Built-ins are code-reviewed modules; configuration cannot import arbitrary code. */
export async function getWorkerProtocols():Promise<Map<WorkerKind,WorkerProtocol>>{
  const [{codexWorker},{claudeCodeWorker},{openCodeProtocol},{piProtocol}]=await Promise.all([
    import('./codex.js'),import('./claude-code.js'),import('./opencode.js'),import('./pi.js'),
  ]);
  return new Map<WorkerKind,WorkerProtocol>([['codex',codexWorker],['claude-code',claudeCodeWorker],['opencode',openCodeProtocol],['pi',piProtocol]]);
}
