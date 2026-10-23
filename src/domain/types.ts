export interface HarnessTask {
  schemaVersion: '1.0'|'1.1'; taskId: string; prompt: string; requirements: string[];
  acceptanceCriteria: string[]; requiredCapabilities?: string[]; context?: Record<string, unknown>; allowedDomains?: string[];
  desiredOutput?: 'text'|'screenshot'|'image'|'video'|'mixed'|'patch'; maxCostUsd?: number;
  timeoutMs?: number; allowPaidExecution?: boolean; parentRunId?: string;
  preferredRouteId?: string; allowUnknownCost?: boolean;
  workspace?: import('../workspace/types.js').WorkspaceRequest;
}
export interface Route {
  id: string; description: string; agent_model_profile?: string|null;
  generation_model_id?: string|null; modalities: string[]; eligible_requirements: string[];
  price_usd?: number|null; price_status: 'known'|'estimated'|'unknown'|'unverified'|'not_applicable'; enabled?: boolean;
  fallback_requirements?: string[];
}
export interface HarnessManifest {
  id: string; kind: 'external_agent_runtime'|'custom_agent_harness'|'host_defer';
  transport: 'pi_rpc'|'in_process'|'none'|'subprocess'; enabled: boolean; permissions: string[];
  capabilities: string[]; default_timeout_ms: number; routes: Route[];
}
export interface Registry {version: 1; harnesses: HarnessManifest[]}
export interface Artifact {
  type: 'image'|'video'|'screenshot'|'text'|'other'|'patch'; path?: string; url?: string;
  mimeType?: string; verified: boolean; providerRequestId?: string;
}
export interface Cost {status: 'known'|'estimated'|'unknown'|'not_applicable'; usd?: number; details?: string}
export type MeteringSource = 'provider_reported'|'platform_estimated'|'manual_import'|'unavailable';
export interface TokenCounters {
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  cacheWriteInputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number;
}
export interface UsageRecord {
  schemaVersion: '1.0'; provider: string; model?: string; source: string;
  measurement: MeteringSource; completeness: 'complete'|'partial'|'unavailable';
  tokens: TokenCounters; details?: string; evidenceRef?: string;
}
export interface CostComponent {
  provider: string; model?: string; source: string;
  status: 'provider_reported'|'rate_estimate'|'unknown'; usd?: number;
  requestId?: string; details?: string;
}
export interface MediaOutput {provider:string;model?:string;kind:'image'|'video';count:number;requestIds?:string[]}
export interface BenchmarkRunRecord {
  schemaVersion: '1.0'; benchmarkRunId: string; caseId: string; arm: string; repetition: number;
  promptHash: string; startedAt: string; durationMs?: number; timestampSource?: 'run_time'|'import_time';
  status: 'completed'|'failed'|'timed_out'|'interrupted';
  outcome: 'verified_success'|'verified_failure'|'ungraded';
  gradeEvidence?: string; gradedAt?: string;
  codex?: {threadId?: string; model?: string; modelSource?: 'requested'|'manual_import'; profile?: string; outputPath?: string; exitCode?: number; version?: string; reasoningEffort?: string; evidencePath?: string};
  usageImportHistory?: Array<{importedAt:string;evidencePath:string}>;
  mediaImportHistory?: Array<{importedAt:string;evidencePath:string}>;
  harnessRunIds: string[]; usage: UsageRecord[]; costComponents: CostComponent[]; mediaOutputs?: MediaOutput[];
  errorCode?: string;
}
export interface BenchmarkUsageSummary {
  attempts: number; verifiedSuccesses: number; verifiedFailures: number; ungraded: number;
  verifiedSuccessRate: number|null; gradedSuccessRate: number|null;
  timing: {completedCount:number;medianCompletedMs:number|null;p95CompletedMs:number|null;medianAllAttemptsMs:number|null};
  usageByProviderModel: Record<string,{inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;cacheWriteInputTokens?:number;reasoningOutputTokens?:number;totalTokens?:number;records:number;completeRecords:number;partialRecords:number;unavailableRecords:number;tasksWithUsage:number;completeTasks:number;partialTasks:number;unavailableTasks:number;inputTokenTaskSamples:number;outputTokenTaskSamples:number;totalTokenTaskSamples:number;meanInputTokensPerTask:number|null;meanOutputTokensPerTask:number|null;meanTotalTokensPerTask:number|null;sourceCounts:Record<string,number>;measurementCounts:Record<string,number>}>;
  mediaByProviderModel: Record<string,{images:number;videos:number;requestIds:string[]}>;
  costByProviderModel: Record<string,{providerReportedUsd:number;rateEstimateUsd:number;unknownComponents:number}>;
  cost: {providerReportedUsd:number;rateEstimateUsd:number;unknownComponents:number;perVerifiedSuccessUsd:{status:'complete'|'estimated'|'partial'|'unavailable';providerReportedUsd?:number;rateEstimateUsd?:number}};
}
export interface HarnessResult {
  schemaVersion: '1.1'|'1.2'|'1.3'; runId: string; taskId: string;
  status: 'completed'|'failed'|'rejected'|'defer_to_host'|'permission_required'|'cancelled';
  selectedRouteId: string|null; selectedHarnessId?: string|null; selectedModelId?: string|null;
  summary?: string; structuredOutput?: Record<string, unknown>; artifacts: Artifact[];
  criterionResults: CriterionResult[];
  timing: {totalMs: number; decisionMs?: number; handoffMs?: number; executionMs?: number; verificationMs?: number};
  cost: Cost; usage?: UsageRecord[]; costComponents?: CostComponent[];
  error?: {code: string; message: string; retryable?: boolean}; tracePath?: string;
}
export interface CriterionResult {
  criterion: string;
  status: 'passed'|'failed'|'unverified';
  verifier: 'artifact'|'browser_observation'|'provider_metadata'|'planner_provenance'|'none';
  evidence?: string;
}
export interface Health {available: boolean; reason?: string; modelId?: string; provider?: string}
export interface AdapterResult {
  status: HarnessResult['status']; summary: string; structuredOutput?: Record<string, unknown>;
  artifacts: Artifact[]; selectedModelId?: string|null; cost: Cost;
  usage?: UsageRecord[]; costComponents?: CostComponent[];
  timing?: {handoffMs?: number; executionMs?: number; verificationMs?: number};
  error?: HarnessResult['error'];
}
export interface TraceSink {event(type: string, data?: unknown): Promise<void>}
export interface Budget {
  readonly remainingUsd: number;
  reserve(usd: number, label: string): Promise<string>;
  settle(reservationId: string, cost: Cost): Promise<void>;
}
export interface ExecutionContext {
  runId: string; routeId: string; route: Route; modelProfileId?: string;
  budgetUsd: number; signal: AbortSignal; artifactsDir: string;
  trace: TraceSink; budget: Budget;
  /** Present only when the selected route is a named route profile. */
  profile?: {
    id: string;
    permissions: 'read-only' | 'patch';
    systemInstructions?: string;
    enabledTools: readonly string[];
    model: string;
    allowedMcpServers: readonly string[];
  };
}
export interface HarnessAdapter {
  id: string; health(options?: {signal?: AbortSignal}): Promise<Health>;
  /** Adapter-specific no-network preflight and evidence verification. */
  preflight?(task: HarnessTask, ctx: ExecutionContext): Promise<void>;
  verify?(task: HarnessTask, output: AdapterResult, ctx: ExecutionContext): Promise<void>;
  execute(task: HarnessTask, ctx: ExecutionContext): Promise<AdapterResult>;
  cancel?(runId: string): Promise<void>; close?(): Promise<void>;
}
export interface DecisionTrace {
  schemaVersion: '1.0'|'1.1'; decisionProvider?:import('../routing/decision-provider.js').DecisionProvider; runId: string; eligibleRouteIds: string[];
  excludedRoutes?: {id: string; reason: string}[];
  decisionStatus: 'selected'|'not_required'|'refused'|'timeout'|'unavailable'|'no_candidates'|'invalid_response';
  selectedRouteId?: string|null; confidence?: number;
  probabilities?: {value: string; probability: number}[]; latencyMs?: number;
  decisionModel?: string; providerDecisionId?: string; reason?: string;
}
