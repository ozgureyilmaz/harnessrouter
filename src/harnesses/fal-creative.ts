import {ApiError} from '@fal-ai/client';
import {randomUUID} from 'node:crypto';
import {mkdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import type {Artifact, AdapterResult, ExecutionContext, HarnessAdapter, HarnessTask, Health} from '../domain/types.js';
import {RouterError} from '../domain/errors.js';
import {downloadImage as defaultDownloadImage, verifyImage as defaultVerifyImage} from '../observability/artifacts.js';
import {claimCreativeRun, saveCreativeRunState, type CreativeRunState} from './creative/journal.js';
import {createFalQueuePort, type FalQueuePort, type FalModelId} from './creative/fal-queue.js';
import {planCreativeTask, type CreativePlan} from './creative/planner.js';
import {CREATIVE_PROFILES, MAX_IMAGE_COST_USD} from './creative/profiles.js';

const imageOutputSchema = z.object({
  images: z.array(z.object({
    url: z.string().url(),
    content_type: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).passthrough()).min(1),
  has_nsfw_concepts: z.array(z.boolean()).optional(),
  seed: z.number().int().optional(),
}).passthrough();

type ImageMetadata = Awaited<ReturnType<typeof defaultVerifyImage>>;
type DownloadImage = typeof defaultDownloadImage;
type VerifyImage = typeof defaultVerifyImage;

export interface CreativeHarnessOptions {
  apiKey?: string;
  allowPaid?: boolean;
  dryRun?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  queue?: FalQueuePort;
  downloadImage?: DownloadImage;
  verifyImage?: VerifyImage;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<AdapterResult>;
  queue?: FalQueuePort;
  profile?: CreativePlan['profile'];
  requestId?: string;
  reservationId?: string;
  submissionStarted: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
}

const KNOWN_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const CANCEL_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStatus(value: unknown): string | undefined {
  return isRecord(value) && typeof value.status === 'string' ? value.status : undefined;
}

function getProviderError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.error === 'string') return value.error;
  if (typeof value.error_type === 'string') return value.error_type;
  return undefined;
}

function extractOutput(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}

function mimeExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  throw new RouterError('artifact_invalid', 'The fal output is not a supported image type.');
}

function costForEstimate(plan: CreativePlan) {
  return {
    status: 'estimated' as const,
    usd: plan.estimatedCostUsd,
    details: `Catalog rate estimate: $${plan.profile.priceUsdPerMegapixel.toFixed(3)} per megapixel; actual invoice amount was not returned by the queue result.`,
  };
}

function notChargedCost() {
  return {status: 'not_applicable' as const, usd: 0, details: 'No fal queue request was submitted.'};
}

function unknownCost() {
  return {status: 'unknown' as const, details: 'A fal queue request may have been accepted; the full reservation is retained pending reconciliation.'};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, {once: true});
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof RouterError) return error.message;
  if (error instanceof ApiError) return `fal returned HTTP ${error.status}.`;
  if (error instanceof Error && error.name === 'TimeoutError') return 'fal creative task timed out.';
  if (error instanceof Error && error.name === 'AbortError') return 'fal creative task was cancelled.';
  return 'fal creative execution failed; inspect the run trace for its stage.';
}

function safeHttpStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

function baseResult(task: HarnessTask, ctx: ExecutionContext, options: {
  status: AdapterResult['status'];
  summary: string;
  error?: AdapterResult['error'];
  selectedModelId?: string | null;
  artifacts?: Artifact[];
  structuredOutput?: Record<string, unknown>;
  cost?: AdapterResult['cost'];
  timing?: AdapterResult['timing'];
}): AdapterResult {
  return {
    status: options.status,
    summary: options.summary,
    selectedModelId: options.selectedModelId ?? null,
    artifacts: options.artifacts ?? [],
    structuredOutput: options.structuredOutput,
    cost: options.cost ?? notChargedCost(),
    timing: options.timing,
    error: options.error,
  };
}

export class CreativeHarness implements HarnessAdapter {
  readonly id = 'fal-creative';
  private readonly apiKey?: string;
  private readonly allowPaid: boolean;
  private readonly dryRun: boolean;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly downloadImage: DownloadImage;
  private readonly verifyImage: VerifyImage;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly options: CreativeHarnessOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FAL_KEY;
    this.allowPaid = options.allowPaid ?? false;
    this.dryRun = options.dryRun ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.downloadImage = options.downloadImage ?? defaultDownloadImage;
    this.verifyImage = options.verifyImage ?? defaultVerifyImage;
  }

  async preflight(task:HarnessTask,ctx:ExecutionContext):Promise<void>{
    const plan=planCreativeTask(task,ctx);
    if(!plan.ok)throw new RouterError(plan.code,plan.message);
  }
  async health(): Promise<Health> {
    if (!this.apiKey) return {available: false, reason: 'FAL_KEY is missing', provider: 'fal'};
    if (!this.allowPaid) return {available: false, reason: 'paid fal execution has not been enabled', provider: 'fal'};
    if (this.dryRun) return {available: false, reason: 'ROUTER_DRY_RUN is enabled', provider: 'fal'};
    return {available: true, provider: 'fal'};
  }

  execute(task: HarnessTask, ctx: ExecutionContext): Promise<AdapterResult> {
    const prior = this.activeRuns.get(ctx.runId);
    if (prior) return prior.promise;

    const controller = new AbortController();
    const timeoutController = new AbortController();
    const timeoutMs = Math.min(this.timeoutMs, task.timeoutMs ?? this.timeoutMs);
    const timer = setTimeout(() => timeoutController.abort(new DOMException('Creative execution timed out', 'TimeoutError')), timeoutMs);
    const signal = AbortSignal.any([ctx.signal, controller.signal, timeoutController.signal]);
    const active: ActiveRun = {
      controller, promise: Promise.resolve(baseResult(task, ctx, {status: 'failed', summary: 'Run initializing'})),
      submissionStarted: false, cancelRequested: false, cancelSent: false,
    };
    const promise = this.executeOnce(task, ctx, signal, timeoutController, active)
      .catch(async error => {
        const mayHaveSubmitted = active.submissionStarted && !active.requestId;
        const cost = active.submissionStarted ? unknownCost() : notChargedCost();
        if (active.reservationId) await ctx.budget.settle(active.reservationId, cost).catch(() => undefined);
        const cancelled = ctx.signal.aborted || active.cancelRequested;
        const code = mayHaveSubmitted ? 'reconciliation_required' : cancelled ? 'cancelled' : 'creative_internal_error';
        const message = mayHaveSubmitted
          ? 'fal may have accepted the request, but no request ID was received. This run will not submit again.'
          : errorMessage(error);
        return baseResult(task, ctx, {
          status: cancelled ? 'cancelled' : 'failed',
          summary: message,
          selectedModelId: active.profile?.modelId,
          structuredOutput: {providerRequestId: active.requestId},
          error: {code, message, retryable: false},
          cost,
        });
      })
      .finally(() => {
        clearTimeout(timer);
        this.activeRuns.delete(ctx.runId);
      });
    active.promise = promise;
    this.activeRuns.set(ctx.runId, active);
    return promise;
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancelRequested = true;
    active.controller.abort(new DOMException('Cancelled by router', 'AbortError'));
    await this.cancelProvider(active);
  }

  private async cancelProvider(active: ActiveRun): Promise<void> {
    if (active.cancelSent || !active.queue || !active.profile || !active.requestId) return;
    active.cancelSent = true;
    try {
      await active.queue.cancel(active.profile.modelId, active.requestId, AbortSignal.timeout(CANCEL_TIMEOUT_MS));
    } catch {
      // Cancellation can lose a race with completion; the queue request ID is kept for reconciliation.
    }
  }

  private async executeOnce(task: HarnessTask, ctx: ExecutionContext, signal: AbortSignal, timeoutController: AbortController, active: ActiveRun): Promise<AdapterResult> {
    const start = performance.now();
    const planned = planCreativeTask(task, ctx);
    if (!planned.ok) {
      await ctx.trace.event('creative.rejected', {code: planned.code, message: planned.message, routeId: ctx.route.id});
      return baseResult(task, ctx, {
        status: 'rejected', summary: planned.message,
        error: {code: planned.code, message: planned.message, retryable: false},
      });
    }
    const plan = planned.plan;
    active.profile = plan.profile;

    const structuredPlan = {
      profileId: plan.profile.profileId,
      modelId: plan.profile.modelId,
      aspectRatio: plan.aspectRatio,
      expectedAspectRatio: plan.expectedAspectRatio,
      expectedWidth: plan.expectedWidth,
      expectedHeight: plan.expectedHeight,
      estimatedCostUsd: plan.estimatedCostUsd,
      inputFingerprint: plan.inputFingerprint,
      parentRunId: plan.parentRunId,
      observationFingerprint: plan.observationFingerprint,
      sourceUrl: plan.sourceUrl,
      observedFields: plan.observedFields,
    };

    if (task.allowPaidExecution !== true || !this.allowPaid || this.dryRun) {
      const message = 'Paid image generation requires task authorization, ROUTER_ALLOW_PAID_RUNS=true, and ROUTER_DRY_RUN=false.';
      await ctx.trace.event('creative.permission_required', structuredPlan);
      return baseResult(task, ctx, {
        status: 'permission_required', summary: message,
        selectedModelId: plan.profile.modelId,
        structuredOutput: structuredPlan,
        error: {code: 'paid_execution_disabled', message, retryable: false},
      });
    }
    if (!this.apiKey) {
      const message = 'FAL_KEY is required to execute this fal profile.';
      await ctx.trace.event('creative.unavailable', {code: 'credentials_missing', ...structuredPlan});
      return baseResult(task, ctx, {
        status: 'failed', summary: message, selectedModelId: plan.profile.modelId,
        structuredOutput: structuredPlan,
        error: {code: 'credentials_missing', message, retryable: false},
      });
    }
    if (plan.estimatedCostUsd > MAX_IMAGE_COST_USD) {
      const message = 'The estimated image charge exceeds the hard per-image limit.';
      return baseResult(task, ctx, {
        status: 'rejected', summary: message, selectedModelId: plan.profile.modelId,
        structuredOutput: structuredPlan,
        error: {code: 'budget_exceeded', message, retryable: false},
      });
    }

    await ctx.trace.event('creative.planned', structuredPlan);
    const claim = await claimCreativeRun(ctx.artifactsDir, {
      schemaVersion: 1,
      runId: ctx.runId,
      inputFingerprint: plan.inputFingerprint,
      modelId: plan.profile.modelId,
      expectedAspectRatio: plan.expectedAspectRatio,
      expectedWidth: plan.expectedWidth,
      expectedHeight: plan.expectedHeight,
      estimatedCostUsd: plan.estimatedCostUsd,
      parentRunId: plan.parentRunId,
      observationFingerprint: plan.observationFingerprint,
      sourceUrl: plan.sourceUrl,
    });

    if (claim.kind === 'blocked') {
      const hasReservation = Boolean(claim.state?.reservationId);
      const cost = hasReservation ? unknownCost() : notChargedCost();
      await ctx.trace.event('creative.reconciliation_required', {code: claim.code, requestId: claim.state?.requestId, modelId: plan.profile.modelId});
      return baseResult(task, ctx, {
        status: 'failed', summary: claim.message, selectedModelId: plan.profile.modelId,
        structuredOutput: structuredPlan, cost,
        error: {code: claim.code, message: claim.message, retryable: false},
      });
    }

    if (claim.kind === 'cached') {
      return this.returnCached(task, ctx, plan, claim.state, start, signal);
    }

    let state = claim.state;
    let reservationId = state.reservationId;
    if (claim.kind === 'fresh') {
      try {
        reservationId = await ctx.budget.reserve(plan.estimatedCostUsd, `fal image ${plan.profile.modelId}`);
        active.reservationId = reservationId;
        state = {...state, phase: 'prepared', reservationId};
        await saveCreativeRunState(ctx.artifactsDir, state);
      } catch (error) {
        const message = errorMessage(error);
        if (reservationId) await ctx.budget.settle(reservationId, notChargedCost()).catch(() => undefined);
        await saveCreativeRunState(ctx.artifactsDir, {...state, phase: 'failed'}).catch(() => undefined);
        await ctx.trace.event('creative.budget_rejected', {modelId: plan.profile.modelId, code: 'budget_exceeded'});
        return baseResult(task, ctx, {
          status: 'rejected', summary: message, selectedModelId: plan.profile.modelId,
          structuredOutput: structuredPlan,
          error: {code: 'budget_exceeded', message, retryable: false},
        });
      }
    }
    if (!reservationId) {
      const message = 'The saved fal request has no budget reservation; reconciliation is required.';
      return baseResult(task, ctx, {
        status: 'failed', summary: message, selectedModelId: plan.profile.modelId,
        structuredOutput: structuredPlan, cost: unknownCost(),
        error: {code: 'reconciliation_required', message, retryable: false},
      });
    }
    active.reservationId = reservationId;

    const queue = this.options.queue ?? createFalQueuePort({apiKey: this.apiKey, signal});
    active.queue = queue;
    let requestId = claim.kind === 'resume' ? state.requestId : undefined;
    active.requestId = requestId;
    let submissionStarted = false;
    let executionMs = 0;
    let handoffMs = 0;

    try {
      if (!requestId) {
        state = {...state, phase: 'submitting', reservationId};
        await saveCreativeRunState(ctx.artifactsDir, state);
        const handoffStart = performance.now();
        submissionStarted = true;
        active.submissionStarted = true;
        const submitted = await queue.submit(plan.profile.modelId, plan.input, signal);
        handoffMs = performance.now() - handoffStart;
        requestId = submitted.requestId;
        if (typeof requestId !== 'string' || requestId.trim().length === 0) {
          throw new RouterError('reconciliation_required', 'fal accepted a submission without returning a request ID.');
        }
        active.requestId = requestId;
        state = {...state, phase: 'submitted', requestId, reservationId};
        await saveCreativeRunState(ctx.artifactsDir, state);
        await ctx.trace.event('creative.submitted', {modelId: plan.profile.modelId, requestId, handoffMs});
      }

      const executionStart = performance.now();
      const completed = await this.waitForCompletion(queue, plan.profile.modelId, requestId, signal, ctx, active);
      if (getProviderError(completed)) {
        throw new RouterError('fal_provider_error', 'fal reported an error for the queued image request.');
      }

      const rawResult = await queue.result(plan.profile.modelId, requestId, signal);
      executionMs = performance.now() - executionStart;
      const parsed = imageOutputSchema.safeParse(extractOutput(rawResult));
      if (!parsed.success) throw new RouterError('artifact_invalid', 'fal returned an output that does not match the image result schema.');
      if (parsed.data.images.length !== 1) throw new RouterError('artifact_invalid', 'fal returned a different number of images than requested.');
      if (parsed.data.has_nsfw_concepts?.some(Boolean)) throw new RouterError('unsafe_output', 'fal marked the generated image as unsafe.');

      const image = parsed.data.images[0]!;
      const verificationStart = performance.now();
      const metadata = await this.saveAndVerifyImage(image.url, ctx.artifactsDir, plan, signal);
      const verificationMs = performance.now() - verificationStart;
      const artifactRelativePath = `fal-image.${mimeExtension(metadata.mimeType)}`;
      const artifact: Artifact = {
        type: 'image',
        path: join(ctx.artifactsDir, artifactRelativePath),
        url: image.url,
        mimeType: metadata.mimeType,
        verified: true,
        providerRequestId: requestId,
      };
      const summary = `Generated one ${plan.aspectRatio} image with ${plan.profile.label} and verified the downloaded artifact.`;
      state = {
        ...state,
        phase: 'completed',
        reservationId,
        requestId,
        artifactPath: artifactRelativePath,
        artifactUrl: image.url,
        mimeType: metadata.mimeType as CreativeRunState['mimeType'],
        width: metadata.width,
        height: metadata.height,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        summary,
      };
      await saveCreativeRunState(ctx.artifactsDir, state);
      const cost = costForEstimate(plan);
      await ctx.budget.settle(reservationId, cost);
      await ctx.trace.event('creative.artifact_verified', {
        modelId: plan.profile.modelId, requestId, mimeType: metadata.mimeType,
        width: metadata.width, height: metadata.height, bytes: metadata.bytes,
        sha256: metadata.sha256, expectedAspectRatio: plan.expectedAspectRatio,
        estimatedCostUsd: plan.estimatedCostUsd,
      });

      return baseResult(task, ctx, {
        status: 'completed', summary, selectedModelId: plan.profile.modelId,
        artifacts: [artifact],
        structuredOutput: {...structuredPlan, width: metadata.width, height: metadata.height, mimeType: metadata.mimeType, seed: parsed.data.seed},
        cost,
        timing: {handoffMs, executionMs, verificationMs},
      });
    } catch (error) {
      const httpStatus = safeHttpStatus(error);
      const definiteRejection = submissionStarted && !requestId && httpStatus !== undefined && KNOWN_REJECTION_STATUSES.has(httpStatus);
      const requestMayExist = submissionStarted && !requestId && !definiteRejection;
      const cancelled = ctx.signal.aborted || active.cancelRequested || (signal.aborted && !timeoutController.signal.aborted);
      const timedOut = timeoutController.signal.aborted && !ctx.signal.aborted && !active.cancelRequested;
      let cost: AdapterResult['cost'] = notChargedCost();

      if (state.phase === 'completed') {
        cost = unknownCost();
      } else if (requestId) {
        cost = unknownCost();
        state = {...state, phase: 'submitted', requestId, reservationId};
        await this.cancelProvider(active);
      } else if (requestMayExist) {
        cost = unknownCost();
        state = {...state, phase: 'ambiguous', reservationId};
      } else if (definiteRejection) {
        state = {...state, phase: 'failed', reservationId};
      } else if (submissionStarted) {
        // Local failure after preparing but before the POST leaves no known charge.
        state = {...state, phase: 'failed', reservationId};
      } else {
        state = {...state, phase: 'failed', reservationId};
      }

      await saveCreativeRunState(ctx.artifactsDir, state).catch(() => undefined);
      await ctx.budget.settle(reservationId, cost).catch(() => undefined);

      const code = requestMayExist ? 'reconciliation_required'
        : definiteRejection ? 'fal_request_rejected'
          : cancelled ? 'cancelled'
            : timedOut ? 'creative_timeout'
              : error instanceof RouterError ? error.code : 'fal_execution_failed';
      const message = requestMayExist
        ? 'fal may have accepted the request, but no request ID was received. This run will not submit again.'
        : errorMessage(error);
      await ctx.trace.event(requestMayExist ? 'creative.submit_ambiguous' : 'creative.failed', {
        code, modelId: plan.profile.modelId, requestId, httpStatus,
        submissionAttempted: submissionStarted, suppressedRetry: queue.suppressedRetry,
        retryableHttpStatus: queue.retryableHttpStatus,
      });

      return baseResult(task, ctx, {
        status: state.phase === 'completed' ? 'completed' : cancelled ? 'cancelled' : 'failed', summary: message,
        selectedModelId: plan.profile.modelId,
        artifacts: state.phase === 'completed' && state.artifactPath && state.artifactUrl && state.mimeType && requestId
          ? [{type: 'image', path: join(ctx.artifactsDir, state.artifactPath), url: state.artifactUrl, mimeType: state.mimeType, verified: true, providerRequestId: requestId}]
          : [],
        structuredOutput: {...structuredPlan, providerRequestId: requestId},
        cost,
        error: {code: state.phase === 'completed' ? 'post_completion_error' : code, message, retryable: state.phase !== 'completed' && Boolean(requestId) && !cancelled && !timedOut},
        timing: {handoffMs, executionMs},
      });
    }
  }

  private async waitForCompletion(queue: FalQueuePort, modelId: FalModelId, requestId: string, signal: AbortSignal, ctx: ExecutionContext, active: ActiveRun): Promise<unknown> {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
      const status = await queue.status(modelId, requestId, signal);
      const state = getStatus(status);
      await ctx.trace.event('creative.queue_status', {modelId, requestId, status: state ?? 'invalid'});
      if (state === 'COMPLETED') return status;
      if (state !== 'IN_QUEUE' && state !== 'IN_PROGRESS') {
        throw new RouterError('fal_status_invalid', 'fal returned an unsupported queue status.');
      }
      if (active.cancelRequested) throw new DOMException('Cancelled by router', 'AbortError');
      await delay(this.pollIntervalMs, signal);
    }
  }

  private async saveAndVerifyImage(url: string, directory: string, plan: CreativePlan, signal: AbortSignal): Promise<ImageMetadata> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `.fal-image-${randomUUID()}.download`);
    let destination: string | undefined;
    try {
      const metadata = await this.downloadImage(url, temporary, signal);
      const extension = mimeExtension(metadata.mimeType);
      destination = join(directory, `fal-image.${extension}`);
      await rename(temporary, destination);
      return await this.verifyImage(destination, {expectedRatio: plan.expectedAspectRatio, signal});
    } catch (error) {
      await rm(temporary, {force: true}).catch(() => undefined);
      if (destination) await rm(destination, {force: true}).catch(() => undefined);
      throw error;
    }
  }

  private async returnCached(task: HarnessTask, ctx: ExecutionContext, plan: CreativePlan, state: CreativeRunState, start: number, signal: AbortSignal): Promise<AdapterResult> {
    if (!state.artifactPath || !state.artifactUrl || !state.mimeType || !state.requestId) {
      return baseResult(task, ctx, {
        status: 'failed', summary: 'The completed fal journal has no verified artifact metadata.',
        selectedModelId: plan.profile.modelId, cost: costForEstimate(plan),
        error: {code: 'reconciliation_required', message: 'The saved result is incomplete; no new request was sent.', retryable: false},
      });
    }
    const path = join(ctx.artifactsDir, state.artifactPath);
    try {
      const verificationStart = performance.now();
      const metadata = await this.verifyImage(path, {expectedRatio: plan.expectedAspectRatio, signal});
      const verificationMs = performance.now() - verificationStart;
      const artifact: Artifact = {
        type: 'image', path, url: state.artifactUrl, mimeType: metadata.mimeType,
        verified: true, providerRequestId: state.requestId,
      };
      return baseResult(task, ctx, {
        status: 'completed', summary: state.summary ?? 'Reused the previously verified fal artifact.',
        selectedModelId: plan.profile.modelId, artifacts: [artifact],
        structuredOutput: {
          profileId: plan.profile.profileId, modelId: plan.profile.modelId,
          aspectRatio: plan.aspectRatio, expectedAspectRatio: plan.expectedAspectRatio,
          width: metadata.width, height: metadata.height, mimeType: metadata.mimeType,
          providerRequestId: state.requestId, estimatedCostUsd: plan.estimatedCostUsd,
          parentRunId: state.parentRunId, observationFingerprint: state.observationFingerprint,
          sourceUrl: state.sourceUrl,
        },
        cost: costForEstimate(plan),
        timing: {executionMs: performance.now() - start, verificationMs},
      });
    } catch {
      return baseResult(task, ctx, {
        status: 'failed', summary: 'The saved fal artifact is no longer verifiable.',
        selectedModelId: plan.profile.modelId, cost: costForEstimate(plan),
        error: {code: 'artifact_invalid', message: 'The completed result exists, but its local image failed verification. No new request was sent.', retryable: false},
      });
    }
  }
}

export {CREATIVE_PROFILES};
