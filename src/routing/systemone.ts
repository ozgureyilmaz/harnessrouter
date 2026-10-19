import {performance} from 'node:perf_hooks';
import {RouterError, checkAbort} from '../domain/errors.js';
import type {Budget, Cost, HarnessTask, TraceSink} from '../domain/types.js';
import {decisionInput, parseDecision, type DecisionChoice, type DecisionResult, type DecisionUsage} from './decisions.js';
import type {DecisionSelector, SystemOneSelectorOptions} from './decision-provider.js';
import {DecisionHttpError, postDecisionJson, type DecisionHttpTransport} from './decision-http.js';

/** Additional injection exists only in trusted application/test construction, never task input. */
export type SystemOneClientOptions = SystemOneSelectorOptions & {transport?: DecisionHttpTransport};
const QUESTION = 'execution_route';
const LOCAL_COST: Cost = {status: 'not_applicable', usd: 0, details: 'Local Ollaya compute is not priced as a provider USD charge'};
const JEV_COST: Cost = {status: 'unknown', details: 'TypeSafe returned no reconciled per-request USD charge; the reservation remains committed'};
function record(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}

/** Provider origins are trusted configuration. Hosted Jev cannot be redirected to a different service. */
export function validateSystemOneBaseUrl(provider: 'jev'|'ollaya', value: string): string {
  let url: URL;
  try {url = new URL(value);} catch {throw new RouterError('invalid_config', 'Invalid System One endpoint origin');}
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new RouterError('invalid_config', 'System One endpoint must be an HTTP(S) origin without credentials, path, query or fragment');
  if (provider === 'jev') {
    if (url.protocol !== 'https:' || url.hostname !== 'api.typesafe.ai' || (url.port && url.port !== '443')) throw new RouterError('invalid_config', 'Jev endpoint must be https://api.typesafe.ai');
  } else if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new RouterError('invalid_config', 'Ollaya endpoint must use a loopback hostname');
  return url.origin;
}
function safeUsage(raw: unknown): DecisionUsage|undefined {
  if (!record(raw)) return undefined;
  const result: DecisionUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) if (Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0) result[key] = Number(raw[key]);
  return Object.keys(result).length ? result : undefined;
}
function normalizeResponse(raw: unknown, choices: readonly DecisionChoice[]): unknown {
  if (!record(raw) || !record(raw.answers) || Object.keys(raw.answers).length !== 1 || !Object.hasOwn(raw.answers, QUESTION) || !record(raw.answers[QUESTION])) throw new RouterError('invalid_decision', 'System One must return exactly one execution_route answer');
  if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 200 || /[\x00-\x1f\x7f]/.test(raw.model)) throw new RouterError('invalid_decision', 'System One model metadata is invalid');
  const answer = raw.answers[QUESTION];
  let probabilities: Array<{value: string; probability: unknown}>|undefined;
  if (Object.hasOwn(answer, 'probabilities')) {
    if (!record(answer.probabilities)) throw new RouterError('invalid_decision', 'System One probabilities must be an option map');
    const offered = new Set(choices.map((choice) => choice.value));
    probabilities = Object.entries(answer.probabilities).map(([value, probability]) => {
      if (!offered.has(value) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new RouterError('invalid_decision', 'System One probability metadata is invalid');
      return {value, probability};
    });
  }
  return {model: raw.model, answers: [{...answer, name: QUESTION, ...(probabilities === undefined ? {} : {probabilities})}], ...(raw.usage === undefined ? {} : {usage: safeUsage(raw.usage)})};
}
async function settle(budget: Budget, id: string, cost: Cost): Promise<void> {
  try {await budget.settle(id, cost);} catch {throw new RouterError('budget_settlement_failed', 'Unable to reconcile the System One reservation');}
}
function safeFailure(error: unknown, signal: AbortSignal): RouterError {
  if (signal.aborted) return new RouterError('cancelled', 'System One request cancelled');
  if (error instanceof RouterError) return new RouterError(error.code, 'System One request failed; no retry or fallback was attempted');
  return new RouterError('decision_network_error', 'System One connection failed; no retry or fallback was attempted');
}

export class SystemOneDecisionsClient implements DecisionSelector {
  readonly provider: 'jev'|'ollaya';
  readonly requiresPaid: boolean;
  readonly reservationUsd: number;
  private readonly model: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly transport: DecisionHttpTransport;
  constructor(private readonly options: SystemOneClientOptions) {
    if (!['jev', 'ollaya'].includes(options.provider)) throw new RouterError('invalid_config', 'Unknown System One provider');
    this.provider = options.provider; this.requiresPaid = this.provider === 'jev';
    this.model = options.model ?? (this.requiresPaid ? 'jev-latest' : 'laya:typed-decisions');
    this.origin = validateSystemOneBaseUrl(this.provider, options.baseUrl ?? (this.requiresPaid ? 'https://api.typesafe.ai' : 'http://localhost:11435'));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.reservationUsd = this.requiresPaid ? options.reservationUsd ?? 0.01 : 0;
    if (!this.model.trim() || this.model.length > 200 || /[\x00-\x1f\x7f]/.test(this.model) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647 || !Number.isFinite(this.reservationUsd) || this.requiresPaid && this.reservationUsd <= 0 || options.apiKey && /[\x00-\x1f\x7f]/.test(options.apiKey)) throw new RouterError('invalid_config', 'Invalid System One model, timeout, reservation or API key');
    this.transport = options.transport ?? postDecisionJson;
  }
  async choose(task: HarnessTask, choices: DecisionChoice[], signal: AbortSignal, trace: TraceSink, budget: Budget): Promise<DecisionResult> {
    checkAbort(signal);
    if (choices.length < 2 || choices.length > 255) throw new RouterError(choices.length === 0 ? 'no_eligible_route' : 'decision_requires_multiple_choices', 'System One requires between 2 and 255 eligible routes');
    const offered = new Set<string>();
    for (const choice of choices) {
      if (typeof choice.value !== 'string' || !choice.value || choice.value.length > 256 || offered.has(choice.value) || typeof choice.description !== 'string' || !choice.description.trim()) throw new RouterError('invalid_decision', 'Route choices must have unique IDs and nonempty descriptions');
      offered.add(choice.value);
    }
    if (this.options.dryRun) throw new RouterError('dry_run_execution_disabled', 'System One execution is disabled during dry run');
    if (this.requiresPaid && !this.options.allowPaid) throw new RouterError('paid_execution_not_authorized', 'Jev selection requires paid-call authorization');
    if (this.requiresPaid && !this.options.apiKey?.trim()) throw new RouterError('credential_missing:jev', 'A TypeSafe API key is required for Jev selection');
    const body = {model: this.model, state: decisionInput(task), questions: {[QUESTION]: {
      type: 'choice', instructions: 'Choose exactly one offered execution route that best satisfies the task. Routes are pre-authorized executable options; never invent an ID.',
      criteria: Object.fromEntries(choices.map(({value, description}) => [value, description.slice(0, 500)])),
    }}};
    const reservation = this.requiresPaid ? await budget.reserve(this.reservationUsd, 'TypeSafe Jev route selection') : undefined;
    const started = performance.now();
    try {
      checkAbort(signal);
      await trace.event('decision.requested', {provider: this.provider, model: this.model, question: QUESTION, eligibleRouteIds: [...offered], reservedUsd: this.reservationUsd});
      checkAbort(signal);
    } catch (error) {if (reservation) await settle(budget, reservation, {status: 'not_applicable', usd: 0, details: 'Cancelled before System One request'}); throw error;}
    const cost = this.requiresPaid ? JEV_COST : LOCAL_COST;
    let response: Awaited<ReturnType<DecisionHttpTransport>>;
    try {response = await this.transport({url: `${this.origin}/v1/systemone`, body, apiKey: this.options.apiKey, signal, timeoutMs: this.timeoutMs});}
    catch (error) {
      if (reservation) await settle(budget, reservation, cost);
      const failure = safeFailure(error, signal);
      await trace.event(failure.code === 'invalid_decision' ? 'decision.invalid_response' : 'decision.failed', {provider: this.provider, model: this.model, code: failure.code, ...(error instanceof DecisionHttpError ? {providerStatus: error.status, providerDecisionId: error.requestId} : {}), latencyMs: Math.max(0, performance.now() - started), cost});
      throw failure;
    }
    if (reservation) await settle(budget, reservation, cost);
    const latencyMs = Math.max(0, performance.now() - started);
    const usage = record(response.data) ? safeUsage(response.data.usage) : undefined;
    const common = {provider: this.provider, model: this.model, ...(response.requestId ? {providerDecisionId: response.requestId} : {}), ...(usage ? {usage} : {}), latencyMs, cost};
    try {await trace.event('decision.response', common);} catch {throw new RouterError('trace_write_failed', 'Unable to persist the System One response trace');}
    let parsed: ReturnType<typeof parseDecision>;
    try {checkAbort(signal); parsed = parseDecision(normalizeResponse(response.data, choices), choices);}
    catch (error) {
      const failure = error instanceof RouterError ? error : new RouterError('invalid_decision', 'System One response could not be parsed');
      await trace.event(failure.code === 'decision_refused' ? 'decision.refused' : failure.code === 'cancelled' ? 'decision.failed' : 'decision.invalid_response', {...common, code: failure.code});
      throw failure;
    }
    const result: DecisionResult = {...parsed, provider: this.provider, latencyMs, ...(response.requestId ? {providerDecisionId: response.requestId} : {}), cost};
    await trace.event('decision.completed', {...common, model: parsed.model, routeId: parsed.routeId, ...(parsed.confidence === undefined ? {} : {confidence: parsed.confidence}), ...(parsed.probabilities === undefined ? {} : {probabilities: parsed.probabilities})});
    return result;
  }
}
