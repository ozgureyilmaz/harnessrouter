import {RouterError} from '../domain/errors.js';
import {redact} from '../observability/trace.js';

/** One sanitized line from a Pi or provider error. Secrets and extra lines stay out. */
export function piErrorLine(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const redacted = redact(value);
  if (typeof redacted !== 'string') return undefined;
  const line = redacted.split(/\r?\n/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  return line ? line.slice(0, 240) : undefined;
}

export function piFailure(record: {code?: unknown; error?: unknown; message?: unknown}, provider?: string): Error {
  const detail = piErrorLine(record.error) ?? piErrorLine(record.message);
  const missingKey = record.code === 'PI_CREDENTIAL_MISSING' || (detail ? /no api key|credential_missing|authentication/i.test(detail) : false);
  if (missingKey) return new RouterError('credential_missing', `Pi has no API key for provider "${provider ?? 'unknown'}"${detail ? `. ${detail}` : ''}`);
  return new Error(`WORKER_EXECUTION_FAILED: Pi runtime reported an error${detail ? `: ${detail}` : ''}`);
}

export function piBootstrapFailure(error: unknown): {code: string; message: string} {
  const detail = piErrorLine(error instanceof Error ? error.message : undefined) ?? 'Pi runtime failed before it returned a result';
  if (/no api key|credential_missing/i.test(detail)) return {code: 'PI_CREDENTIAL_MISSING', message: detail.replace(/^WORKER_CREDENTIAL_MISSING:\s*/, '')};
  if (/WORKER_MODEL_UNAVAILABLE|absent from pinned catalog/i.test(detail)) return {code: 'PI_MODEL_UNAVAILABLE', message: detail};
  return {code: 'PI_RUNTIME_FAILED', message: detail};
}
