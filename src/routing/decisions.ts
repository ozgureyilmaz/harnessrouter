import OpenAI from 'openai';
import type {DecisionCreateParams} from 'openai/resources/decisions.js';
import {performance} from 'node:perf_hooks';
import {RouterError, checkAbort} from '../domain/errors.js';
import type {Budget, Cost, HarnessTask, TraceSink} from '../domain/types.js';
import type {DecisionProvider} from './decision-provider.js';
import {redact} from '../observability/trace.js';

export const DECISION_RESERVE_USD = 0.01;
const DEFAULT_MODEL = 'gpt-6-luna';
const QUESTION_NAME = 'execution_route';
const INPUT_PRICE_PER_MILLION_USD = 0.1;

export interface DecisionChoice {
  value: string;
  description: string;
}

export interface DecisionProbability {
  value: string;
  probability: number;
}

export interface ParsedDecision {
  routeId: string;
  model: string;
  confidence?: number;
  probabilities?: DecisionProbability[];
  usage?: DecisionUsage;
}

export interface DecisionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface DecisionResult extends ParsedDecision {
  provider?:DecisionProvider;
  latencyMs: number;
  providerDecisionId?: string;
  cost: Cost;
}

interface DecisionRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

interface DecisionsApiClient {
  decisions: {
    create(
      body: DecisionCreateParams,
      options?: DecisionRequestOptions,
    ): {
      withResponse(): Promise<{data: unknown; request_id: string | null}>;
    };
  };
}

export interface DecisionsClientOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  reservationUsd?: number;
  allowPaid: boolean;
  dryRun: boolean;
  /** Injection point for offline tests; production uses the official OpenAI SDK. */
  client?: DecisionsApiClient;
}

/** Strictly parse a single Decisions choice and prove it was one of the offered values. */
export function parseDecision(response: unknown, choices: readonly DecisionChoice[]): ParsedDecision {
  const offered = new Set(choices.map(choice => choice.value));
  if (offered.size !== choices.length || choices.some(choice => !choice.value)) {
    throw new RouterError('invalid_decision', 'Offered route choices must have unique, non-empty values');
  }
  if (!isRecord(response) || !Array.isArray(response.answers) || response.answers.length !== 1) {
    throw new RouterError('invalid_decision', 'Decision response must contain exactly one answer');
  }

  const answer = response.answers[0];
  if (!isRecord(answer)) throw new RouterError('invalid_decision', 'Decision answer is malformed');
  if (answer.name !== QUESTION_NAME) {
    throw new RouterError('invalid_decision', 'Decision answer name does not match execution_route');
  }
  if (answer.type === 'refusal') throw new RouterError('decision_refused', 'Decisions declined to select an execution route');
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new RouterError('invalid_decision', 'Decision answer is not the named execution_route choice');
  }
  if (!offered.has(answer.choice)) {
    throw new RouterError('invalid_decision', 'Decision selected a route that was not offered');
  }
  if (typeof response.model !== 'string' || response.model.trim().length === 0) {
    throw new RouterError('invalid_decision', 'Decision response omitted its model');
  }

  let confidence: number | undefined;
  if (Object.hasOwn(answer, 'confidence')) {
    confidence = probabilityValue(answer.confidence, 'confidence');
  }

  let probabilities: DecisionProbability[] | undefined;
  if (Object.hasOwn(answer, 'probabilities')) {
    if (!Array.isArray(answer.probabilities)) throw new RouterError('invalid_decision', 'Decision probabilities are malformed');
    const seen = new Set<string>();
    probabilities = answer.probabilities.map(item => {
      if (!isRecord(item) || typeof item.value !== 'string' || !offered.has(item.value)) {
        throw new RouterError('invalid_decision', 'Decision probability references a route that was not offered');
      }
      if (seen.has(item.value)) throw new RouterError('invalid_decision', 'Decision probabilities contain a duplicate route');
      seen.add(item.value);
      return {value: item.value, probability: probabilityValue(item.probability, 'probability')};
    });
  }

  const usage = normalizeUsage(response.usage);
  return {
    routeId: answer.choice,
    model: response.model,
    ...(confidence === undefined ? {} : {confidence}),
    ...(probabilities === undefined ? {} : {probabilities}),
    ...(usage ? {usage} : {}),
  };
}

/**
 * Paid Decisions API wrapper. It never retries a request: after an ambiguous
 * transport failure, retrying could create an untracked second charge.
 */
export class DecisionsClient {
  readonly provider='openai' as const;
  readonly requiresPaid=true;
  readonly reservationUsd:number;
  private readonly api: DecisionsApiClient | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: DecisionsClientOptions) {
    this.reservationUsd=options.reservationUsd??DECISION_RESERVE_USD;
    if(!Number.isFinite(this.reservationUsd)||this.reservationUsd<=0)throw new RouterError('invalid_config','Decision reservation must be positive and finite');
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (this.model !== DEFAULT_MODEL) throw new RouterError('invalid_config', `Decisions routing is pinned to ${DEFAULT_MODEL}`);
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RouterError('invalid_config', 'Decision timeout must be a positive integer');

    if (options.client) {
      this.api = options.client;
    } else {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (apiKey) this.api = new OpenAI({apiKey, timeout: this.timeoutMs, maxRetries: 0});
    }
  }

  async choose(
    task: HarnessTask,
    choices: DecisionChoice[],
    signal: AbortSignal,
    trace: TraceSink,
    budget: Budget,
  ): Promise<DecisionResult> {
    checkAbort(signal);
    if (choices.length === 0) throw new RouterError('no_eligible_route', 'No eligible route choices were provided');
    if (choices.length < 2) {
      throw new RouterError('decision_requires_multiple_choices', 'Decisions choice questions require at least two offered options');
    }
    if (this.options.dryRun) throw new RouterError('dry_run_execution_disabled', 'Decisions API calls are disabled during dry run');
    if (!this.options.allowPaid) throw new RouterError('paid_execution_not_authorized', 'Decisions API calls require paid-call approval');
    if (!this.api) throw new RouterError('credential_missing:openai', 'OPENAI_API_KEY is required for Decisions routing');

    const offered = new Set<string>();
    for (const choice of choices) {
      if (!choice.value || offered.has(choice.value) || typeof choice.description !== 'string' || !choice.description.trim()) {
        throw new RouterError('invalid_decision', 'Decision choices must have unique IDs and non-empty descriptions');
      }
      offered.add(choice.value);
    }

    const requestBody: DecisionCreateParams = {
      model: this.model,
      input: decisionInput(task),
      questions: [{
        name: QUESTION_NAME,
        type: 'choice',
        instructions: 'Choose exactly one execution route ID that best satisfies the task. The route IDs are pre-authorized and executable options. Never invent an ID.',
        choices: choices.map(({value, description}) => ({value, description: boundedText(description, 500)})),
      }],
    };
    const reservationId = await budget.reserve(this.reservationUsd, 'OpenAI Decisions route selection');
    const started = performance.now();
    try {
      checkAbort(signal);
      await trace.event('decision.requested', {
        provider:this.provider,model: this.model,
        question: QUESTION_NAME,
        eligibleRouteIds: choices.map(choice => choice.value),
        reservedUsd: this.reservationUsd,
        request: redact(requestBody),
      });
    } catch (error) {
      await settleBudget(budget, reservationId, {status: 'not_applicable', usd: 0, details: 'Cancelled before provider request'});
      throw error;
    }

    let response: {data: unknown; request_id: string | null};
    try {
      const apiRequest = this.api.decisions.create(requestBody, {signal, timeout: this.timeoutMs, maxRetries: 0});
      response = await apiRequest.withResponse();
    } catch (error) {
      const latencyMs = elapsed(started);
      const metadata = safeProviderErrorMetadata(error);
      const failure = classifyProviderError(error, signal, metadata);
      await settleBudget(budget, reservationId, {
        status: 'unknown',
        details: 'The request may have reached the provider; exact usage was not returned',
      });
      await trace.event('decision.failed', {
        provider:this.provider,model: this.model,
        code: failure.code,
        ...metadata,
        latencyMs,
        cost: {status: 'unknown'},
      });
      throw failure;
    }

    const latencyMs = elapsed(started);
    const raw = response.data;
    const usage = isRecord(raw) ? normalizeUsage(raw.usage) : undefined;
    const cost = estimateDecisionCost(usage);
    let responseTraceError: unknown;
    try {
      await trace.event('decision.response', {
        provider:this.provider,providerDecisionId: response.request_id ?? undefined,
        response: redact(sanitizeDecisionResponse(raw)),
      });
    } catch (error) {
      responseTraceError = error;
    }
    await settleBudget(budget, reservationId, cost);
    if (responseTraceError) throw new RouterError('trace_write_failed', 'Unable to persist the Decisions response trace');

    let parsed: ParsedDecision;
    try {
      parsed = parseDecision(raw, choices);
    } catch (error) {
      const failure = error instanceof RouterError ? error : new RouterError('invalid_decision', 'Decision response could not be parsed');
      await trace.event(failure.code === 'decision_refused' ? 'decision.refused' : 'decision.invalid_response', {
        provider:this.provider,model: this.model, ...(response.request_id?{providerDecisionId:response.request_id}:{}),
        ...(usage?{usage}:{}), code: failure.code, latencyMs, cost,
      });
      throw failure;
    }

    const result: DecisionResult = {
      ...parsed,provider:this.provider,
      latencyMs,
      ...(response.request_id ? {providerDecisionId: response.request_id} : {}),
      cost,
    };
    await trace.event('decision.completed', {
      routeId: result.routeId,provider:this.provider,
      model: result.model,
      ...(result.confidence === undefined ? {} : {confidence: result.confidence}),
      ...(result.probabilities === undefined ? {} : {probabilities: result.probabilities}),
      ...(result.providerDecisionId ? {providerDecisionId: result.providerDecisionId} : {}),
      ...(result.usage ? {usage: result.usage} : {}),
      latencyMs,
      cost,
    });
    return result;
  }
}

export function decisionInput(task: HarnessTask): string {
  const parts = [
    `Objective:\n${task.prompt.slice(0, 12_000)}`,
    `Required capabilities: ${boundedText(task.requirements.join(', '), 2_000)}`,
    `Acceptance criteria: ${boundedText(task.acceptanceCriteria.join(' | '), 4_000)}`,
  ];
  if (task.desiredOutput) parts.push(`Desired output: ${task.desiredOutput}`);
  if (task.allowedDomains?.length) parts.push(`Authorized domains: ${boundedText(task.allowedDomains.join(', '), 2_000)}`);
  if (task.maxCostUsd !== undefined) parts.push(`Task maximum cost: USD ${task.maxCostUsd.toFixed(4)}`);
  const creativeOptions = validatedCreativeOptions(task);
  if (creativeOptions && Object.keys(creativeOptions).length) {
    parts.push(`Validated creative options: ${JSON.stringify(creativeOptions)}`);
  }
  // Arbitrary context is deliberately omitted; browser URLs are represented by the explicit allowlist.
  return parts.join('\n\n');
}

function validatedCreativeOptions(task: HarnessTask): Record<string, string | number> | undefined {
  const raw = task.context?.creativeOptions;
  const isImageTask = task.desiredOutput === 'image' || task.requirements.some(requirement => ['image', 'text_to_image'].includes(requirement.trim().toLowerCase()));
  if (raw === undefined) return isImageTask ? {quality: 'balanced'} : undefined;
  if (!isRecord(raw)) return undefined;
  const allowed = new Set(['aspectRatio', 'style', 'quality', 'negativePrompt', 'seed']);
  if (Object.keys(raw).some(key => !allowed.has(key))) return undefined;

  const result: Record<string, string | number> = {};
  if (raw.aspectRatio !== undefined) {
    if (typeof raw.aspectRatio !== 'string' || !['1:1', '4:3', '3:4', '16:9', '9:16'].includes(raw.aspectRatio)) return undefined;
    result.aspectRatio = raw.aspectRatio;
  }
  if (raw.style !== undefined) {
    if (typeof raw.style !== 'string' || !raw.style.trim() || raw.style.trim().length > 240) return undefined;
    result.style = raw.style.trim();
  }
  if (raw.quality !== undefined) {
    if (typeof raw.quality !== 'string' || !['fast', 'balanced', 'high'].includes(raw.quality)) return undefined;
    result.quality = raw.quality;
  } else if (isImageTask) {
    result.quality = 'balanced';
  }
  if (raw.negativePrompt !== undefined) {
    if (typeof raw.negativePrompt !== 'string' || !raw.negativePrompt.trim() || raw.negativePrompt.trim().length > 600) return undefined;
    result.negativePrompt = raw.negativePrompt.trim();
  }
  if (raw.seed !== undefined) {
    if (typeof raw.seed !== 'number' || !Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 4_294_967_295) return undefined;
    result.seed = raw.seed;
  }
  return result;
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const suffix = ' [truncated]';
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function sanitizeDecisionResponse(value: unknown): unknown {
  if (!isRecord(value)) return {malformedResponse: true};
  const answers = Array.isArray(value.answers) ? value.answers.slice(0, 8).map(answer => {
    if (!isRecord(answer)) return {malformedAnswer: true};
    const safe: Record<string, unknown> = {};
    for (const key of ['type', 'name', 'choice', 'confidence'] as const) {
      const item = answer[key];
      if (typeof item === 'string') safe[key] = item.slice(0, key === 'choice' ? 256 : 100);
      else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) safe[key] = item;
    }
    if (Array.isArray(answer.probabilities)) {
      safe.probabilities = answer.probabilities.slice(0, 32).map(item => {
        if (!isRecord(item)) return {malformedProbability: true};
        return {
          ...(typeof item.value === 'string' ? {value: item.value.slice(0, 256)} : typeof item.value === 'boolean' ? {value: item.value} : {}),
          ...(typeof item.probability === 'number' && Number.isFinite(item.probability) ? {probability: item.probability} : {}),
        };
      });
    }
    return safe;
  }) : [];
  return {
    ...(typeof value.model === 'string' ? {model: value.model.slice(0, 100)} : {}),
    answers,
    ...(normalizeUsage(value.usage) ? {usage: normalizeUsage(value.usage)} : {}),
  };
}

function estimateDecisionCost(usage: DecisionUsage | undefined): Cost {
  if (!usage || usage.input_tokens === undefined) {
    return {status: 'unknown', details: 'Decisions usage was not returned'};
  }
  const usd = usage.input_tokens * INPUT_PRICE_PER_MILLION_USD / 1_000_000;
  return {
    status: 'estimated',
    usd,
    details: 'Estimated from Decisions input tokens at USD 0.10 per 1M; verify current provider pricing',
  };
}

function normalizeUsage(value: unknown): DecisionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: DecisionUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    const item = value[key];
    if (item !== undefined) {
      if (!Number.isInteger(item) || typeof item !== 'number' || item < 0) return undefined;
      usage[key] = item;
    }
  }
  return Object.keys(usage).length ? usage : undefined;
}

function probabilityValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RouterError('invalid_decision', `Decision ${label} must be between 0 and 1`);
  }
  return value;
}

interface SafeProviderErrorMetadata {
  providerStatus?: number;
  providerCode?: string;
  providerParam?: string;
  providerMessage?: string;
}

function safeProviderErrorMetadata(error: unknown): SafeProviderErrorMetadata {
  if (!isRecord(error)) return {};
  const nested = isRecord(error.error) ? error.error : undefined;
  const providerStatus = typeof error.status === 'number' && Number.isInteger(error.status) ? error.status : undefined;
  const providerCode = safeProviderString(error.code) ?? safeProviderString(nested?.code) ?? safeProviderString(nested?.error);
  const providerParam = safeProviderString(error.param) ?? safeProviderString(nested?.param);
  const rawMessage = typeof nested?.message === 'string'
    ? nested.message
    : typeof error.message === 'string' ? error.message : undefined;
  const redactedMessage = rawMessage === undefined ? undefined : redact(rawMessage);
  const providerMessage = typeof redactedMessage === 'string' ? boundedText(redactedMessage, 500) : undefined;
  return {
    ...(providerStatus === undefined ? {} : {providerStatus}),
    ...(providerCode === undefined ? {} : {providerCode}),
    ...(providerParam === undefined ? {} : {providerParam}),
    ...(providerMessage === undefined ? {} : {providerMessage}),
  };
}

function safeProviderString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const redacted = redact(value);
  return typeof redacted === 'string' ? boundedText(redacted, 100) : undefined;
}

function classifyProviderError(error: unknown, signal: AbortSignal, metadata: SafeProviderErrorMetadata): RouterError {
  if (signal.aborted) return new RouterError('cancelled', 'Decisions request was cancelled');
  const record = isRecord(error) ? error : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const status = metadata.providerStatus;
  const detail = metadata.providerMessage ? ` Provider message: ${metadata.providerMessage}` : '';
  if (status === 401) return new RouterError('auth_invalid', `Decisions authentication failed.${detail}`);
  if (status === 403) return new RouterError('access_denied', `Decisions access was denied.${detail}`);
  if (status === 404) return new RouterError('endpoint_unavailable', `Decisions endpoint was not found.${detail}`);
  if (status === 400) return new RouterError('invalid_request', `Decisions rejected the request.${detail}`);
  if (name.includes('Timeout') || name === 'AbortError') return new RouterError('decision_timeout', `Decisions request timed out.${detail}`, true);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return new RouterError('decision_unavailable', `Decisions provider returned a transient error; request was not retried.${detail}`, true);
  }
  if (name.includes('Connection')) return new RouterError('decision_network_error', `Decisions connection failed; request was not retried because charge status may be ambiguous.${detail}`);
  return new RouterError('decision_provider_error', `Decisions provider request failed.${detail}`);
}

async function settleBudget(budget: Budget, reservationId: string, cost: Cost): Promise<void> {
  try {
    await budget.settle(reservationId, cost);
  } catch {
    throw new RouterError('budget_settlement_failed', 'Unable to reconcile the Decisions budget reservation');
  }
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
