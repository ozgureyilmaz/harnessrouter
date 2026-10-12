import {createFalClient, type FalClient} from '@fal-ai/client';
import type {Flux2Input, FluxSchnellInput} from '@fal-ai/client/endpoints';
import type {CreativeInput} from './planner.js';

export type FalModelId = 'fal-ai/flux/schnell' | 'fal-ai/flux-2';

export interface FalQueuePort {
  submit(modelId: FalModelId, input: CreativeInput, signal: AbortSignal): Promise<{requestId: string}>;
  status(modelId: FalModelId, requestId: string, signal: AbortSignal): Promise<unknown>;
  result(modelId: FalModelId, requestId: string, signal: AbortSignal): Promise<unknown>;
  cancel(modelId: FalModelId, requestId: string, signal: AbortSignal): Promise<void>;
  readonly submissionAttempted: boolean;
  readonly suppressedRetry: boolean;
  readonly retryableHttpStatus?: number;
}

export interface FalQueueOptions {
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class FalSubmitRetrySuppressedError extends Error {
  constructor() {
    super('A repeated fal queue submission was suppressed to avoid duplicate charges.');
    this.name = 'FalSubmitRetrySuppressedError';
  }
}

const RETRYABLE_QUEUE_STATUSES = new Set([429, 502, 503, 504]);

function combineSignals(primary: AbortSignal | undefined, taskSignal: AbortSignal): AbortSignal {
  if (!primary || primary === taskSignal) return taskSignal;
  return AbortSignal.any([primary, taskSignal]);
}

function makeClient(options: FalQueueOptions): {client: FalClient; diagnostics: {
  attempted: boolean; suppressedRetry: boolean; retryableHttpStatus?: number;
}} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const diagnostics = {attempted: false, suppressedRetry: false, retryableHttpStatus: undefined as number | undefined};
  const guardedFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const isQueueSubmission = method === 'POST' && new URL(url).hostname === 'queue.fal.run';
    const isCancellation = method === 'PUT' && new URL(url).pathname.endsWith('/cancel');

    if (isQueueSubmission) {
      if (diagnostics.attempted) {
        diagnostics.suppressedRetry = true;
        throw new FalSubmitRetrySuppressedError();
      }
      diagnostics.attempted = true;
    }

    const response = await fetchImpl(input, {
      ...init,
      signal: isCancellation ? init?.signal ?? undefined : combineSignals(init?.signal ?? undefined, options.signal),
    });

    if (isQueueSubmission && RETRYABLE_QUEUE_STATUSES.has(response.status)) {
      diagnostics.retryableHttpStatus = response.status;
      await response.body?.cancel();
      // The fal SDK retries 429/5xx queue submissions internally. Return a
      // non-retryable response to its retry layer; the caller treats this as
      // ambiguous because no request_id was returned.
      return new Response(JSON.stringify({message: 'fal queue submission outcome requires reconciliation'}), {
        status: 409,
        headers: {'content-type': 'application/json'},
      });
    }
    return response;
  };

  return {
    client: createFalClient({credentials: options.apiKey, fetch: guardedFetch, retry: {maxRetries: 0}}),
    diagnostics,
  };
}

export function createFalQueuePort(options: FalQueueOptions): FalQueuePort {
  const {client, diagnostics} = makeClient(options);

  return {
    get submissionAttempted() {return diagnostics.attempted;},
    get suppressedRetry() {return diagnostics.suppressedRetry;},
    get retryableHttpStatus() {return diagnostics.retryableHttpStatus;},

    async submit(modelId, input, signal) {
      const abortSignal = combineSignals(signal, options.signal);
      let response: {request_id: string};
      if (modelId === 'fal-ai/flux/schnell') {
        response = await client.queue.submit(modelId, {
          input: input as FluxSchnellInput,
          headers: {'X-Fal-No-Retry': '1'},
          abortSignal,
        });
      } else {
        response = await client.queue.submit(modelId, {
          input: input as Flux2Input,
          headers: {'X-Fal-No-Retry': '1'},
          abortSignal,
        });
      }
      return {requestId: response.request_id};
    },

    async status(modelId, requestId, signal) {
      return client.queue.status(modelId, {requestId, logs: false, abortSignal: combineSignals(signal, options.signal)});
    },

    async result(modelId, requestId, signal) {
      return client.queue.result(modelId, {requestId, abortSignal: combineSignals(signal, options.signal)});
    },

    async cancel(modelId, requestId, signal) {
      // Cancellation must remain usable after the task signal itself has fired.
      await client.queue.cancel(modelId, {requestId, abortSignal: signal});
    },
  };
}
