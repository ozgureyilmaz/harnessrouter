import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {RouterError} from '../domain/errors.js';
import {redact} from '../observability/trace.js';

export interface DecisionHttpRequest {
  url: string; body: unknown; apiKey?: string; signal: AbortSignal; timeoutMs: number;
}
export interface DecisionHttpResponse {data: unknown; requestId?: string}
export type DecisionHttpTransport = (input: DecisionHttpRequest) => Promise<DecisionHttpResponse>;
export class DecisionHttpError extends RouterError {
  constructor(code: string, message: string, readonly status?: number, readonly requestId?: string) {super(code, message);}
}
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
function providerErrorDetail(raw: Buffer): {message?: string; code?: string} {
  let parsed: unknown;
  try {parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));} catch {return {};}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const code = typeof record.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(record.code) ? record.code : undefined;
  if (typeof record.error !== 'string') return {code};
  const redacted = redact(record.error);
  if (typeof redacted !== 'string') return {code};
  const message = redacted.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return {code, ...(message ? {message} : {})};
}
function rejectedDecision(status: number, providerCode?: string): {code: string; message: string} {
  if (status >= 300 && status < 400) return {code: 'decision_redirect_denied', message: 'Decision endpoint returned a redirect; no retry was attempted'};
  if (status === 401) return {code: 'auth_invalid', message: 'Decision endpoint rejected the API key; no retry was attempted'};
  if (status === 403) return {code: 'access_denied', message: 'Decision endpoint denied access; no retry was attempted'};
  if (status === 404 && providerCode === 'MODEL_NOT_FOUND') return {code: 'decision_model_unavailable', message: 'The configured decision model is not installed on the local server. Pull it, then route again'};
  if (status === 404) return {code: 'endpoint_unavailable', message: 'Decision endpoint was not found; no retry was attempted'};
  if ([400, 413, 415, 422].includes(status)) return {code: 'invalid_request', message: 'Decision endpoint rejected the request; no retry was attempted'};
  return {code: 'decision_unavailable', message: 'Decision endpoint rejected the request; no retry was attempted'};
}
function requestId(value: string|string[]|undefined): string|undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;
}

/** Native Node HTTP does not read proxy environment variables. One bounded request, no redirect/retry. */
export const postDecisionJson: DecisionHttpTransport = async (input) => {
  if (input.signal.aborted) throw new RouterError('cancelled', 'Decision request cancelled');
  let url: URL; let body: string;
  try {url = new URL(input.url); body = JSON.stringify(input.body);} catch {throw new RouterError('invalid_request', 'Decision request could not be encoded');}
  if (!['http:', 'https:'].includes(url.protocol) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647) throw new RouterError('invalid_config', 'Invalid decision HTTP transport configuration');
  return new Promise((resolve, reject) => {
    let settled = false;
    let currentRequest: ReturnType<typeof httpRequest>|undefined;
    let timer: NodeJS.Timeout|undefined;
    const cleanup = () => {if (timer) clearTimeout(timer); input.signal.removeEventListener('abort', abort);};
    const fail = (error: Error) => {if (settled) return; settled = true; cleanup(); currentRequest?.destroy(); reject(error);};
    const abort = () => fail(new RouterError('cancelled', 'Decision request cancelled'));
    input.signal.addEventListener('abort', abort, {once: true});
    if (input.signal.aborted) {abort(); return;}
    timer = setTimeout(() => fail(new RouterError('decision_timeout', 'Decision request exceeded its time limit')), input.timeoutMs);
    try {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      currentRequest = transport(url, {method: 'POST', agent: false, headers: {
        'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body),
        ...(input.apiKey ? {authorization: `Bearer ${input.apiKey}`} : {}),
      }}, (response) => {
        const id = requestId(response.headers['x-typesafe-request-id']);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          // Keep only a short JSON error string. Raw bodies can echo prompts or credentials.
          const chunks: Buffer[] = []; let bytes = 0;
          const finish = () => {
            const detail = providerErrorDetail(Buffer.concat(chunks));
            const rejected = rejectedDecision(status, detail.code);
            const message = detail.message ? `${rejected.message}. Provider message: ${detail.message}` : rejected.message;
            fail(new DecisionHttpError(rejected.code, message, status, id));
          };
          response.on('data', (chunk: Buffer) => {
            if (settled || bytes >= MAX_ERROR_BYTES) return;
            const slice = chunk.subarray(0, MAX_ERROR_BYTES - bytes);
            bytes += slice.length; chunks.push(slice);
            if (bytes >= MAX_ERROR_BYTES) response.destroy();
          });
          response.on('end', finish);
          response.on('error', finish);
          response.on('aborted', finish);
          return;
        }
        const advertised = Number(response.headers['content-length']);
        if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {response.destroy(); fail(new DecisionHttpError('decision_response_limit', 'Decision response exceeded 1 MiB', status, id)); return;}
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {response.destroy(); fail(new DecisionHttpError('decision_response_limit', 'Decision response exceeded 1 MiB', status, id)); return;}
          chunks.push(chunk);
        });
        response.on('error', () => fail(new DecisionHttpError('decision_network_error', 'Decision response could not be read', status, id)));
        response.on('aborted', () => fail(new DecisionHttpError('decision_network_error', 'Decision response ended unexpectedly', status, id)));
        response.on('end', () => {
          if (settled) return;
          let data: unknown;
          try {data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));}
          catch {fail(new DecisionHttpError('invalid_decision', 'Decision response was not valid UTF-8 JSON', status, id)); return;}
          settled = true; cleanup(); resolve({data, ...(id ? {requestId: id} : {})});
        });
      });
      currentRequest.on('error', () => fail(new RouterError('decision_network_error', 'Decision connection failed; no retry was attempted')));
      currentRequest.end(body);
    } catch {fail(new RouterError('decision_network_error', 'Decision request could not be sent'));}
  });
};
