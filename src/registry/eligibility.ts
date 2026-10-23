import {isIP} from 'node:net';
import {validateRegistry, validateTask} from '../domain/schemas.js';
import {RouterError} from '../domain/errors.js';
import {DECISION_RESERVE_USD} from '../routing/decisions.js';
import {validateSupportedRegistry} from './loader.js';
import type {WorkerProfile} from '../workers/types.js';
import type {RouteProfile} from '../workers/route-profile.js';
import {preferenceSelectsRoute} from '../workers/route-profile.js';
import type {HarnessManifest, HarnessTask, Health, Registry, Route} from '../domain/types.js';

export interface EligibilityPolicy {
  allowPaid: boolean;
  selector?: 'local'|'decisions';
  decisionRequiresPaid?: boolean;
  decisionReservationUsd?: number;
  workerProfiles?: readonly WorkerProfile[];
  routeProfiles?: readonly RouteProfile[];
  allowExecution?: boolean;
  dryRun: boolean;
  allowedDomains: string[];
  remainingBudgetUsd: number;
  credentials: {openai: boolean; fal: boolean};
}

export interface EligibleRoute {
  harness: HarnessManifest;
  route: Route;
}

export interface EligibilityResult {
  eligible: EligibleRoute[];
  excluded: {id: string; reason: string}[];
}

const BLOCKED_REQUIREMENTS = new Set([
  'private_account_action', 'private_account', 'account_login', 'private_data_action',
  'financial_transaction', 'bank_transfer', 'money_transfer', 'credential_access',
  'purchase', 'payment', 'destructive_action',
]);

const VIDEO_REQUIREMENT = /video/i;
const NATIVE_CONTROL_FALLBACK_DESCRIPTION = 'Control fallback: return the task to the current host only when specialist delegation is unsuitable; this route does not perform browser or media execution.';
const PRIVATE_ACCOUNT_PROMPT = /\b(?:my|private|personal)\s+(?:(?:bank|financial|trading|brokerage|crypto|investment|email|social)\s+)?account\b|\b(?:log\s*in|login|sign\s*in)\b.{0,80}\b(?:my|private|personal|bank|account)\b|\b(?:transfer|withdraw|deposit|send|move|trade|purchase|buy|sell)\b.{0,80}\b(?:from|to|through|using|with)\s+(?:my|the)\s+(?:(?:bank|financial|investment|crypto|trading)\s+)?account\b/i;

const MODALITY_REQUIREMENTS: Record<string, string[]> = {
  browser: ['text'],
  public_site_research: ['text'],
  coding: ['text'],
  host_owned_tasks: ['text'],
  screenshot: ['screenshot'],
  image: ['image'],
  text_to_image: ['image'],
  video: ['video'],
  text_to_video: ['video'],
};

/**
 * Deterministically removes routes that are undeclared, unavailable, outside
 * task policy, missing credentials, or outside the current cost authorization.
 * Missing health is treated as unreachable, never as healthy.
 */
export function getEligibleRoutes(
  task: HarnessTask,
  registry: Registry,
  health: Record<string, Health>,
  policy: EligibilityPolicy,
): EligibilityResult {
  return admitDecisionSelection(task, getExecutableRoutes(task, registry, health, policy), policy);
}

/** Execution authorization is independent of whether a subsequent choice incurs a fee. */
export function getExecutableRoutes(
  task: HarnessTask,
  registry: Registry,
  health: Record<string, Health>,
  policy: EligibilityPolicy,
): EligibilityResult {
  validateTask(task);
  validateRegistry(registry);
  validateSupportedRegistry(registry, policy.workerProfiles, policy.routeProfiles);
  validatePolicy(policy);

  const eligible: EligibleRoute[] = [];
  const excluded: EligibilityResult['excluded'] = [];
  const globallyKnownRequirements = new Set(
    registry.harnesses.flatMap(harness => harness.routes.flatMap(route => route.eligible_requirements.map(normalizeRequirement))),
  );
  const requirements = task.requirements.map(normalizeRequirement);
  const unknownRequirements = requirements.filter(requirement => !globallyKnownRequirements.has(requirement));
  const blockedRequirement = requirements.find(requirement => BLOCKED_REQUIREMENTS.has(requirement));
  const privatePrompt = PRIVATE_ACCOUNT_PROMPT.test(task.prompt);
  const videoTask = task.desiredOutput === 'video' || requirements.some(requirement => VIDEO_REQUIREMENT.test(requirement));

  let taskWideBlock: string | undefined;
  if (blockedRequirement || privatePrompt) taskWideBlock = 'private_account_action_denied';
  else if (videoTask) taskWideBlock = 'video_disabled';
  else if (unknownRequirements.length) taskWideBlock = `unknown_requirement:${unknownRequirements[0]}`;
  else if (requirements.length === 0) taskWideBlock = 'requirements_missing';

  for (const harness of registry.harnesses) {
    for (const route of harness.routes) {
      const fail = (reason: string) => excluded.push({id: route.id, reason});
      if (taskWideBlock) {
        fail(taskWideBlock);
        continue;
      }
      if (!harness.enabled) {
        fail('harness_disabled');
        continue;
      }
      if (route.enabled === false) {
        fail('route_disabled');
        continue;
      }

      const worker = policy.workerProfiles?.find(profile => profile.id === harness.id);
      if (worker) {
        if(!worker.enabled || !worker.allowExecution || policy.allowExecution !== true){fail('worker_execution_not_authorized');continue;}
        if(!task.workspace){fail('workspace_required');continue;}
        if(task.desiredOutput==='patch' && task.workspace.mode!=='patch'){fail('workspace_write_not_authorized');continue;}
        if(!worker.allowUnknownCost || task.allowUnknownCost!==true){fail('unknown_cost_not_authorized');continue;}
      }
      const named=(policy.routeProfiles??[]).filter(item=>item.harness===harness.id);
      if(named.length>0&&route.id===`${harness.id}:configured`&&task.preferredRouteId!==route.id){fail('route_profile_defined');continue;}
      if(!preferenceSelectsRoute(task.preferredRouteId,route.id,policy.routeProfiles)){fail('route_not_requested');continue;}

      const routeRequirements = new Set(route.eligible_requirements.map(normalizeRequirement));
      const unmetRequirement = requirements.find(requirement => !routeRequirements.has(requirement));
      if (unmetRequirement) {
        fail(`requirement_not_supported:${unmetRequirement}`);
        continue;
      }

      const harnessCapabilities = new Set(harness.capabilities.map(normalizeRequirement));
      const unmetCapability = (task.requiredCapabilities ?? [])
        .map(normalizeRequirement)
        .find(capability => !harnessCapabilities.has(capability));
      if (unmetCapability) {
        fail(`capability_not_supported:${unmetCapability}`);
        continue;
      }

      if (harness.kind === 'host_defer' && !requirements.some(requirement => requirement === 'coding' || requirement === 'host_owned_tasks')) {
        fail('native_defer_only_for_host_owned_work');
        continue;
      }

      const requiredModalities = getRequiredModalities(task, requirements);
      const routeModalities = new Set(route.modalities.map(normalizeRequirement));
      const unmetModality = requiredModalities.find(modality => !routeModalities.has(modality));
      if (unmetModality) {
        fail(`modality_not_supported:${unmetModality}`);
        continue;
      }

      const permissionFailure = checkPermissions(task, requirements, harness, route);
      if (permissionFailure) {
        fail(permissionFailure);
        continue;
      }

      const domainFailure = checkDomains(task, harness, requirements, policy.allowedDomains);
      if (domainFailure) {
        fail(domainFailure);
        continue;
      }

      const healthRecords = [health[harness.id], health[route.id]].filter((entry): entry is Health => entry !== undefined);
      if (healthRecords.length === 0) {
        fail('health_not_checked');
        continue;
      }
      const unavailableHealth = healthRecords.find(entry => !entry.available);
      if (unavailableHealth) {
        fail(`unavailable:${safeReason(unavailableHealth.reason)}`);
        continue;
      }
      const routeHealth = health[route.id] ?? health[harness.id];
      if (!routeHealth?.available) {
        fail('health_not_checked');
        continue;
      }

      const credentialFailure = checkCredentials(harness, routeHealth, policy.credentials);
      if (credentialFailure) {
        fail(credentialFailure);
        continue;
      }

      if (policy.dryRun && harness.kind !== 'host_defer') {
        fail('dry_run_execution_disabled');
        continue;
      }

      const paidRoute = harness.permissions.includes('paid_media_generation') || (route.price_usd ?? 0) > 0;
      const piOAuthNotApplicable = harness.id === 'pi-browser' && route.price_status === 'not_applicable' && routeHealth.provider === 'openai-codex';
      if (paidRoute && (!policy.allowPaid || task.allowPaidExecution !== true)) {
        fail('paid_execution_not_authorized');
        continue;
      }

      if(harness.id==='pi-browser'&&(policy.allowExecution!==true||task.allowUnknownCost!==true)){fail('unknown_cost_execution_not_authorized');continue;}
      const priceFailure = worker ? undefined : checkPriceAndBudget(route, task, policy, {paidRoute, piOAuthNotApplicable});
      if (priceFailure) {
        fail(priceFailure);
        continue;
      }

      eligible.push({harness, route});
    }
  }

  addNativeControlFallback(task, registry, health, policy, requirements, taskWideBlock, eligible, excluded);

  return {eligible, excluded};
}

function addNativeControlFallback(
  task: HarnessTask,
  registry: Registry,
  health: Record<string, Health>,
  policy: EligibilityPolicy,
  requirements: string[],
  taskWideBlock: string | undefined,
  eligible: EligibleRoute[],
  excluded: EligibilityResult['excluded'],
): void {
  if (taskWideBlock || policy.dryRun || policy.selector !== 'decisions' || task.preferredRouteId) return;
  if (!eligible.some(candidate => candidate.harness.kind !== 'host_defer')) return;

  const native = registry.harnesses.find(harness => harness.id === 'native');
  const route = native?.routes.find(candidate => candidate.id === 'native:defer');
  if (!native?.enabled || !route || route.enabled === false) return;
  const nativeCapabilities = new Set(native.capabilities.map(normalizeRequirement));
  if ((task.requiredCapabilities ?? []).some(capability => !nativeCapabilities.has(normalizeRequirement(capability)))) return;
  const fallbackRequirements = new Set((route.fallback_requirements ?? []).map(normalizeRequirement));
  if (requirements.length === 0 || requirements.some(requirement => !fallbackRequirements.has(requirement))) return;
  if (route.price_status !== 'not_applicable' || route.price_usd != null) return;

  const healthRecords = [health[native.id], health[route.id]].filter((entry): entry is Health => entry !== undefined);
  if (healthRecords.length === 0 || healthRecords.some(entry => !entry.available)) return;
  const routeHealth = health[route.id] ?? health[native.id];
  if (!routeHealth?.available) return;

  // This is a control handoff, not an execution route: do not apply the native
  // text modality or coding requirements to the specialist task being deferred.
  excluded.splice(0, excluded.length, ...excluded.filter(item => item.id !== route.id));
  eligible.push({
    harness: native,
    route: {...route, description: NATIVE_CONTROL_FALLBACK_DESCRIPTION},
  });
}

function checkCredentials(
  harness: HarnessManifest,
  health: Health,
  credentials: EligibilityPolicy['credentials'],
): string | undefined {
  if (harness.id === 'fal-creative' && !credentials.fal) return 'credential_missing:fal';
  if (harness.id === 'pi-browser' && health.provider === 'openai' && !credentials.openai) return 'credential_missing:openai';
  return undefined;
}

function checkPermissions(task: HarnessTask, requirements: string[], harness: HarnessManifest, route: Route): string | undefined {
  const required = new Set<string>();
  if (requirements.some(requirement => ['browser', 'public_site_research'].includes(requirement))) required.add('public_web_read');
  if (task.desiredOutput === 'screenshot' || requirements.includes('screenshot')) required.add('screenshot');
  if (harness.permissions.includes('paid_media_generation') && requirements.some(requirement => ['image', 'text_to_image'].includes(requirement))) {
    required.add('paid_media_generation');
  }
  const available = new Set(harness.permissions);
  for (const permission of required) {
    if (!available.has(permission)) return `permission_not_declared:${permission}`;
  }
  if (required.has('paid_media_generation') && !route.generation_model_id) return 'generation_model_unconfigured';
  return undefined;
}

function checkDomains(task: HarnessTask, harness: HarnessManifest, requirements: string[], policyDomains: string[]): string | undefined {
  const browserRoute = requirements.some(requirement => ['browser', 'public_site_research', 'screenshot'].includes(requirement))
    || harness.capabilities.some(capability => capability.startsWith('browser.'));
  if (!browserRoute) return undefined;

  const taskDomains = (task.allowedDomains ?? []).map(normalizeDomain).filter((domain): domain is string => domain !== undefined);
  if (taskDomains.length === 0 || taskDomains.length !== (task.allowedDomains?.length ?? 0)) return 'task_domain_not_authorized';
  const configuredDomains = policyDomains.map(normalizeDomain).filter((domain): domain is string => domain !== undefined);
  if (configuredDomains.length !== policyDomains.length) return 'configured_domain_policy_invalid';
  const configured = new Set(configuredDomains);
  if (taskDomains.some(domain => !configured.has(domain))) return 'domain_outside_configured_allowlist';

  const contextUrl = typeof task.context?.url === 'string' ? [task.context.url] : [];
  const promptUrls = [...task.prompt.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map(match => match[0].replace(/[.,;!?]+$/, ''));
  const requestedUrls = [...promptUrls, ...contextUrl];
  for (const value of requestedUrls) {
    let url: URL;
    try { url = new URL(value); } catch { return 'task_url_invalid'; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return 'task_url_not_public_https';
    if (!taskDomains.includes(url.hostname.toLowerCase()) || !configured.has(url.hostname.toLowerCase())) return 'task_url_domain_not_authorized';
  }
  return undefined;
}

function checkPriceAndBudget(
  route: Route,
  task: HarnessTask,
  policy: EligibilityPolicy,
  options: {paidRoute: boolean; piOAuthNotApplicable: boolean},
): string | undefined {
  if (route.price_status === 'not_applicable') {
    if (options.piOAuthNotApplicable || route.id.startsWith('native:')) return undefined;
    return 'price_status_not_applicable_unverified';
  }

  const hasHardBudget = task.maxCostUsd !== undefined || Number.isFinite(policy.remainingBudgetUsd);
  const cap = Math.min(task.maxCostUsd ?? Number.POSITIVE_INFINITY, policy.remainingBudgetUsd);
  if (route.price_status === 'unknown' || route.price_status === 'unverified' || route.price_usd === null || route.price_usd === undefined) {
    if (hasHardBudget) return 'price_unknown_under_budget';
    if (!policy.allowPaid || task.allowPaidExecution !== true) return 'paid_execution_not_authorized';
    if (options.paidRoute) return 'price_unknown_for_paid_generation';
    return undefined;
  }
  if (!Number.isFinite(route.price_usd) || route.price_usd < 0) return 'price_invalid';
  if (route.price_usd > cap) return 'budget_exceeded';
  if (route.price_status === 'estimated' && options.paidRoute && !policy.allowPaid) return 'estimated_price_requires_approval';
  return undefined;
}

function requiresPaidSelection(policy:EligibilityPolicy,task:HarnessTask):boolean{return policy.selector==='decisions'&&policy.decisionRequiresPaid!==false&&!task.preferredRouteId;}
function decisionReserve(policy:EligibilityPolicy,task:HarnessTask):number{return requiresPaidSelection(policy,task)?policy.decisionReservationUsd??DECISION_RESERVE_USD:0;}

/** Apply hosted-selection authorization only after executable candidates and explicit pins are known. */
export function admitDecisionSelection(task:HarnessTask,candidates:EligibilityResult,policy:EligibilityPolicy):EligibilityResult {
  validatePolicy(policy);
  if(candidates.eligible.length<=1||!requiresPaidSelection(policy,task))return candidates;
  const reserve=decisionReserve(policy,task);
  const cap=Math.min(task.maxCostUsd??Number.POSITIVE_INFINITY,policy.remainingBudgetUsd);
  const excluded=[...candidates.excluded];
  const eligible=candidates.eligible.filter(candidate=>{
    if(candidate.harness.kind==='host_defer')return true;
    const reason=!policy.allowPaid?'decision_paid_call_not_authorized':cap<reserve?'budget_below_decision_reserve':typeof candidate.route.price_usd==='number'&&candidate.route.price_usd>cap-reserve?'budget_exceeded':undefined;
    if(reason){excluded.push({id:candidate.route.id,reason});return false;}
    return true;
  });
  // A control fallback never turns a rejected specialist task into an eligible host execution.
  if(!eligible.some(candidate=>candidate.harness.kind!=='host_defer')&&!task.requirements.some(requirement=>['coding','host_owned_tasks'].includes(normalizeRequirement(requirement)))){
    for(let index=eligible.length-1;index>=0;index--)if(eligible[index].harness.kind==='host_defer'){
      excluded.push({id:eligible[index].route.id,reason:'no_eligible_specialist_for_control_fallback'});eligible.splice(index,1);
    }
  }
  return {eligible,excluded};
}

function validatePolicy(policy: EligibilityPolicy): void {
  if(policy.decisionRequiresPaid!==undefined&&typeof policy.decisionRequiresPaid!=='boolean'||policy.decisionReservationUsd!==undefined&&(!Number.isFinite(policy.decisionReservationUsd)||policy.decisionReservationUsd<0))throw new RouterError('invalid_policy','Decision provider policy is malformed');
  if (!Number.isFinite(policy.remainingBudgetUsd) || policy.remainingBudgetUsd < 0) {
    throw new RouterError('invalid_policy', 'Remaining task budget must be finite and nonnegative');
  }
  if (typeof policy.allowPaid !== 'boolean' || typeof policy.dryRun !== 'boolean'
    || !Array.isArray(policy.allowedDomains)
    || policy.allowedDomains.some(domain => typeof domain !== 'string')
    || typeof policy.credentials?.openai !== 'boolean' || typeof policy.credentials?.fal !== 'boolean') {
    throw new RouterError('invalid_policy', 'Eligibility policy is malformed');
  }
}

function getRequiredModalities(task: HarnessTask, requirements: string[]): string[] {
  const modalities = new Set<string>();
  if (task.desiredOutput) modalities.add(task.desiredOutput);
  for (const requirement of requirements) {
    for (const modality of MODALITY_REQUIREMENTS[requirement] ?? []) modalities.add(modality);
  }
  return [...modalities];
}

function normalizeRequirement(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes('*')) return undefined;
  let hostname: string;
  try {
    const candidate = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || (candidate.port && candidate.port !== '443')) return undefined;
    if (candidate.pathname !== '/' || candidate.search || candidate.hash) return undefined;
    hostname = candidate.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
  if (isIP(hostname) || hostname === 'localhost' || /\.(?:local|localhost|internal|intranet|lan)$/.test(hostname)) return undefined;
  if (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.')) return undefined;
  return hostname;
}

function safeReason(reason: string | undefined): string {
  if (!reason) return 'runtime_unavailable';
  return /^[a-z0-9_.:-]{1,80}$/i.test(reason) ? reason : 'runtime_unavailable';
}
