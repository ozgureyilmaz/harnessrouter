import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {RouterError} from '../domain/errors.js';

export interface DecisionHttpRequest {
  url: string; body: unknown; apiKey?: string; signal: AbortSignal; timeoutMs: number;
}
export interface DecisionHttpResponse {data: unknown; requestId?: string}
export type DecisionHttpTransport = (input: DecisionHttpRequest) => Promise<DecisionHttpResponse>;
export class DecisionHttpError extends RouterError {
  constructor(code: string, message: string, readonly status?: number, readonly requestId?: string) {super(code, message);}
}
const MAX_RESPONSE_BYTES = 1024 * 1024;
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
          // Error bodies may contain credentials or private input. Never decode or expose them.
          response.destroy();
          const code = status >= 300 && status < 400 ? 'decision_redirect_denied' : status === 401 ? 'auth_invalid' : status === 403 ? 'access_denied' : status === 404 ? 'endpoint_unavailable' : [400, 413, 415, 422].includes(status) ? 'invalid_request' : 'decision_unavailable';
          fail(new DecisionHttpError(code, 'Decision endpoint rejected the request; no retry was attempted', status, id)); return;
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
