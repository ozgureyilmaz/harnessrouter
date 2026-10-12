export class RouterError extends Error {
  constructor(public code: string, message: string, public retryable = false) {super(message); this.name = 'RouterError';}
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new RouterError('cancelled', 'Execution cancelled');
}
