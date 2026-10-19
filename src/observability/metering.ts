import type {
  BenchmarkRunRecord,
  BenchmarkUsageSummary,
  CostComponent,
  MediaOutput,
  MeteringSource,
  TokenCounters,
  UsageRecord,
} from '../domain/types.js';

export interface NormalizeUsageInput {
  provider: string;
  model?: string;
  source: string;
  measurement: MeteringSource;
  counters?: unknown;
  details?: string;
  forcePartial?: boolean;
}

/** Normalize provider-specific counters without adding cached/reasoning subsets twice. */
export function normalizeUsageRecord(input: NormalizeUsageInput): UsageRecord {
  const raw = isRecord(input.counters) ? input.counters : {};
  const inputDetails=isRecord(raw.input_tokens_details)?raw.input_tokens_details:{};
  const outputDetails=isRecord(raw.output_tokens_details)?raw.output_tokens_details:{};
  const tokens: TokenCounters = {};
  assign(tokens, 'inputTokens', count(raw, ['inputTokens', 'input_tokens', 'input', 'prompt_tokens']));
  assign(tokens, 'outputTokens', count(raw, ['outputTokens', 'output_tokens', 'output', 'completion_tokens']));
  assign(tokens, 'cachedInputTokens', count(raw, ['cachedInputTokens', 'cached_input_tokens', 'cacheRead', 'cache_read_input_tokens'])??count(inputDetails,['cached_tokens']));
  assign(tokens, 'cacheWriteInputTokens', count(raw, ['cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheWrite']));
  assign(tokens, 'reasoningOutputTokens', count(raw, ['reasoningOutputTokens', 'reasoning_output_tokens', 'reasoning_tokens', 'reasoningTokens', 'reasoning'])??count(outputDetails,['reasoning_tokens']));
  const reportedTotal = count(raw, ['totalTokens', 'total_tokens', 'total']);
  if (reportedTotal !== undefined) tokens.totalTokens = reportedTotal;
  else if (tokens.inputTokens !== undefined && tokens.outputTokens !== undefined) {
    tokens.totalTokens = tokens.inputTokens + tokens.outputTokens;
  }

  const hasAny = Object.keys(tokens).length > 0;
  const hasCore = tokens.inputTokens !== undefined && tokens.outputTokens !== undefined;
  const consistent=(!hasCore||tokens.totalTokens===tokens.inputTokens!+tokens.outputTokens!)&&(tokens.cachedInputTokens===undefined||tokens.inputTokens===undefined||tokens.cachedInputTokens<=tokens.inputTokens)&&(tokens.cacheWriteInputTokens===undefined||tokens.inputTokens===undefined||tokens.cacheWriteInputTokens<=tokens.inputTokens)&&(tokens.cachedInputTokens===undefined||tokens.cacheWriteInputTokens===undefined||tokens.inputTokens===undefined||tokens.cachedInputTokens+tokens.cacheWriteInputTokens<=tokens.inputTokens)&&(tokens.reasoningOutputTokens===undefined||tokens.outputTokens===undefined||tokens.reasoningOutputTokens<=tokens.outputTokens);
  const completeness = !hasAny ? 'unavailable' : hasCore && consistent && !input.forcePartial ? 'complete' : 'partial';
  return {
    schemaVersion: '1.0', provider: input.provider, ...(input.model ? {model: input.model} : {}),
    source: input.source, measurement: hasAny ? input.measurement : 'unavailable', completeness, tokens,
    ...(input.details ? {details: input.details.slice(0, 500)} : {}),
  };
}

export function importHostUsage(input: {
  provider?: string; model?: string; counters: unknown; sourceLabel: string;
}): UsageRecord {
  return normalizeUsageRecord({
    provider: input.provider ?? 'openai-codex', model: input.model, source: 'codex_app_import',
    measurement: 'manual_import', counters: input.counters,
    details: `Manually imported from ${input.sourceLabel}`,
  });
}

/** Pi SDK input is uncached. Make the canonical input count inclusive of cache. */
export function normalizePiUsage(input:{provider:string;model?:string;counters?:unknown;source?:string}):UsageRecord {
  const raw=isRecord(input.counters)?input.counters:{};
  const uncached=count(raw,['input']);
  const cacheRead=count(raw,['cacheRead']);const cacheWrite=count(raw,['cacheWrite']);
  const normalized={...raw};
  if(uncached!==undefined&&cacheRead!==undefined&&cacheWrite!==undefined)normalized.inputTokens=uncached+cacheRead+cacheWrite;
  else if('input' in raw){delete normalized.input;delete normalized.inputTokens;}
  const usage=normalizeUsageRecord({provider:input.provider,model:input.model,source:input.source??'pi_session_stats',measurement:Object.keys(raw).length?'provider_reported':'unavailable',counters:normalized,forcePartial:uncached!==undefined&&(cacheRead===undefined||cacheWrite===undefined),details:'Pi SDK input excludes cache; normalized input includes cacheRead and cacheWrite. SDK estimated USD is not a subscription charge.'});
  return usage;
}

export interface ParsedCodexJsonl {
  threadId?: string;
  usage: UsageRecord;
  completedTurns: number;
  failedTurns: number;
  malformedLines: number;
  harnessRunIds: string[];
  usageFromHarness: UsageRecord[];
  costsFromHarness: CostComponent[];
  mediaFromHarness: MediaOutput[];
}

/** Parses usage-only fields from Codex JSONL; response text and tool payloads are discarded. */
export function parseCodexJsonl(text: string, model?: string,serverName='harnessrouter'): ParsedCodexJsonl {
  let threadId: string | undefined;
  let completedTurns = 0;
  let failedTurns = 0;
  let malformedLines = 0;
  let usageTurns = 0;
  let missingTurnUsage = false;
  const totals: Record<string, number> = {};
  const harnessRunIds=new Set<string>();const usageFromHarness:UsageRecord[]=[];const costsFromHarness:CostComponent[]=[];const mediaFromHarness:MediaOutput[]=[];
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) { malformedLines++; continue; }
      event = parsed;
    } catch { malformedLines++; continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id.slice(0, 200);
    const linked=extractHarnessResult(event,serverName);
    if(linked){
      harnessRunIds.add(linked.runId);usageFromHarness.push(...linked.usage);costsFromHarness.push(...linked.costs);mediaFromHarness.push(...linked.media);
    }
    if (event.type === 'turn.completed') {
      completedTurns++;
      const usage = usagePayload(event);
      if (!usage) { missingTurnUsage = true; continue; }
      if(normalizeUsageRecord({provider:'openai-codex',source:'codex_cli_jsonl',measurement:'platform_estimated',counters:usage}).completeness!=='complete')missingTurnUsage=true;
      usageTurns++;
      addCounters(totals, usage);
    } else if (event.type === 'turn.failed') {
      failedTurns++;
      const usage = usagePayload(event);
      if (usage) { usageTurns++; addCounters(totals, usage);missingTurnUsage=true; }
      else missingTurnUsage=true;
    }
  }
  const usage = normalizeUsageRecord({
    provider: 'openai-codex', model, source: 'codex_cli_jsonl', measurement: usageTurns ? 'platform_estimated' : 'unavailable',
    counters: totals, forcePartial: missingTurnUsage || usageTurns === 0,
    details: usageTurns ? 'Usage counters read from Codex CLI JSONL; subscription USD is not inferred.' : 'This Codex CLI output contained no usage counters.',
  });
  return { ...(threadId ? {threadId} : {}), usage, completedTurns, failedTurns, malformedLines,harnessRunIds:[...harnessRunIds],usageFromHarness,costsFromHarness,mediaFromHarness };
}

export function aggregateBenchmarkRecords(records: readonly BenchmarkRunRecord[]): {schemaVersion:'1.0';generatedAt:string;attempts:number;byArm:Record<string,BenchmarkUsageSummary>;byCaseAndArm:Record<string,Record<string,BenchmarkUsageSummary>>} {
  const group=(items:readonly BenchmarkRunRecord[],key:(record:BenchmarkRunRecord)=>string):Map<string,BenchmarkRunRecord[]>=>{
    const groups=new Map<string,BenchmarkRunRecord[]>();
    for(const item of items){const name=key(item);const list=groups.get(name)??[];list.push(item);groups.set(name,list);}
    return groups;
  };
  const summarize=(runs:readonly BenchmarkRunRecord[]):BenchmarkUsageSummary=>{
    let verifiedSuccesses = 0, verifiedFailures = 0, ungraded = 0;
    const usageByProviderModel: BenchmarkUsageSummary['usageByProviderModel'] = {};
    const mediaByProviderModel:BenchmarkUsageSummary['mediaByProviderModel']={};
    const costByProviderModel:BenchmarkUsageSummary['costByProviderModel']={};
    let providerReportedUsd = 0, rateEstimateUsd = 0, unknownComponents = 0;
    let reportedComponents=0,estimatedComponents=0;
    for (const run of runs) {
      const taskUsage=new Map<string,{tokens:TokenCounters;completeness:'complete'|'partial'|'unavailable'}>();
      if (run.outcome === 'verified_success') verifiedSuccesses++;
      else if (run.outcome === 'verified_failure') verifiedFailures++;
      else ungraded++;
      for (const usage of run.usage ?? []) {
        const key=`${usage.provider}/${usage.model??'unknown'}`;
        const summary = usageByProviderModel[key] ??= {records:0,completeRecords:0,partialRecords:0,unavailableRecords:0,tasksWithUsage:0,completeTasks:0,partialTasks:0,unavailableTasks:0,inputTokenTaskSamples:0,outputTokenTaskSamples:0,totalTokenTaskSamples:0,meanInputTokensPerTask:null,meanOutputTokensPerTask:null,meanTotalTokensPerTask:null,sourceCounts:{},measurementCounts:{}};
        summary.sourceCounts[usage.source]=(summary.sourceCounts[usage.source]??0)+1;
        summary.measurementCounts[usage.measurement]=(summary.measurementCounts[usage.measurement]??0)+1;
        summary.records++;
        if (usage.completeness === 'complete') summary.completeRecords++;
        else if (usage.completeness === 'partial') summary.partialRecords++;
        else summary.unavailableRecords++;
        addTokenSummary(summary, usage.tokens);
        const taskRecord=taskUsage.get(key)??{tokens:{},completeness:'complete' as const};
        addTokenCounters(taskRecord.tokens,usage.tokens);
        if(usage.completeness==='unavailable')taskRecord.completeness='unavailable';
        else if(usage.completeness==='partial'&&taskRecord.completeness==='complete')taskRecord.completeness='partial';
        taskUsage.set(key,taskRecord);
      }
      for(const [key,taskRecord] of taskUsage){
        const summary=usageByProviderModel[key]!;summary.tasksWithUsage++;
        if(taskRecord.completeness==='complete')summary.completeTasks++;
        else if(taskRecord.completeness==='partial')summary.partialTasks++;
        else summary.unavailableTasks++;
        if(taskRecord.tokens.inputTokens!==undefined)summary.inputTokenTaskSamples++;
        if(taskRecord.tokens.outputTokens!==undefined)summary.outputTokenTaskSamples++;
        if(taskRecord.tokens.totalTokens!==undefined)summary.totalTokenTaskSamples++;
      }
      for(const media of run.mediaOutputs??[]){
        const key=`${media.provider}/${media.model??'unknown'}`;
        const summary=mediaByProviderModel[key]??={images:0,videos:0,requestIds:[]};
        if(media.kind==='image')summary.images+=media.count;else summary.videos+=media.count;
        for(const id of media.requestIds??[])if(!summary.requestIds.includes(id))summary.requestIds.push(id);
      }
      for (const component of run.costComponents ?? []) {
        const key=`${component.provider}/${component.model??'unknown'}`;
        const componentSummary=costByProviderModel[key]??={providerReportedUsd:0,rateEstimateUsd:0,unknownComponents:0};
        if (component.status === 'provider_reported' && validUsd(component.usd)) {reportedComponents++;providerReportedUsd += component.usd;componentSummary.providerReportedUsd+=component.usd;}
        else if (component.status === 'rate_estimate' && validUsd(component.usd)) {estimatedComponents++;rateEstimateUsd += component.usd;componentSummary.rateEstimateUsd+=component.usd;}
        else {unknownComponents++;componentSummary.unknownComponents++;}
      }
    }
    for(const summary of Object.values(usageByProviderModel)){
      summary.meanInputTokensPerTask=summary.inputTokenTaskSamples&&summary.inputTokens!==undefined?summary.inputTokens/summary.inputTokenTaskSamples:null;
      summary.meanOutputTokensPerTask=summary.outputTokenTaskSamples&&summary.outputTokens!==undefined?summary.outputTokens/summary.outputTokenTaskSamples:null;
      summary.meanTotalTokensPerTask=summary.totalTokenTaskSamples&&summary.totalTokens!==undefined?summary.totalTokens/summary.totalTokenTaskSamples:null;
    }
    const denominator = verifiedSuccesses;
    let costStatus: BenchmarkUsageSummary['cost']['perVerifiedSuccessUsd']['status'] = 'unavailable';
    let providerPerSuccess: number|undefined;
    let estimatePerSuccess: number|undefined;
    if (denominator > 0 && (reportedComponents>0||estimatedComponents>0)) {
      if(reportedComponents)providerPerSuccess = providerReportedUsd / denominator;
      if(estimatedComponents)estimatePerSuccess = rateEstimateUsd / denominator;
      costStatus = unknownComponents ? 'partial' : estimatedComponents>0 ? 'estimated' : 'complete';
    }
    const allDurations=runs.map(run=>run.durationMs).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
    const completedDurations=runs.filter(run=>run.status==='completed').map(run=>run.durationMs).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
    return {
      attempts:runs.length, verifiedSuccesses, verifiedFailures, ungraded,
      verifiedSuccessRate:ungraded?null:runs.length?verifiedSuccesses/runs.length:null,
      gradedSuccessRate:verifiedSuccesses+verifiedFailures ? verifiedSuccesses/(verifiedSuccesses+verifiedFailures) : null,
      timing:{completedCount:completedDurations.length,medianCompletedMs:percentile(completedDurations,.5),p95CompletedMs:percentile(completedDurations,.95),medianAllAttemptsMs:percentile(allDurations,.5)},
      usageByProviderModel,
      mediaByProviderModel,
      costByProviderModel,
      cost:{providerReportedUsd,rateEstimateUsd,unknownComponents,perVerifiedSuccessUsd:{status:costStatus,...(providerPerSuccess===undefined?{}:{providerReportedUsd:providerPerSuccess}),...(estimatePerSuccess===undefined?{}:{rateEstimateUsd:estimatePerSuccess})}},
    };
  };
  const byArm:Record<string,BenchmarkUsageSummary>={};
  for(const [arm,runs] of group(records,record=>record.arm))byArm[arm]=summarize(runs);
  const byCaseAndArm:Record<string,Record<string,BenchmarkUsageSummary>>={};
  const promptVersions=new Map<string,Set<string>>();
  for(const run of records){const versions=promptVersions.get(run.caseId)??new Set<string>();versions.add(run.promptHash);promptVersions.set(run.caseId,versions);}
  for(const [caseId,caseRuns] of group(records,record=>promptVersions.get(record.caseId)!.size>1?`${record.caseId}:${record.promptHash}`:record.caseId)){
    const arms:Record<string,BenchmarkUsageSummary>={};
    for(const [arm,runs] of group(caseRuns,record=>record.arm))arms[arm]=summarize(runs);
    byCaseAndArm[caseId]=arms;
  }
  return {schemaVersion:'1.0',generatedAt:new Date().toISOString(),attempts:records.length,byArm,byCaseAndArm};
}

function percentile(sorted:number[],q:number):number|null {
  if(!sorted.length)return null;
  const index=(sorted.length-1)*q;const lower=Math.floor(index);const upper=Math.ceil(index);
  if(lower===upper)return sorted[lower]!;
  return sorted[lower]!+(sorted[upper]!-sorted[lower]!)*(index-lower);
}

function addTokenSummary(summary: NonNullable<BenchmarkUsageSummary['usageByProviderModel'][string]>, tokens: TokenCounters): void {
  for (const key of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] as const) {
    const value = tokens[key];
    if (value !== undefined) summary[key] = (summary[key] ?? 0) + value;
  }
}

function addTokenCounters(target:TokenCounters,source:TokenCounters):void{
  for(const key of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] as const){
    if(source[key]!==undefined)target[key]=(target[key]??0)+source[key]!;
  }
}

function addCounters(target: Record<string, number>, source: Record<string, unknown>): void {
  const normalized = normalizeUsageRecord({provider:'codex',source:'codex_cli_jsonl',measurement:'platform_estimated',counters:source});
  for (const key of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] as const) {
    const value = normalized.tokens[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function usagePayload(event: Record<string, unknown>): Record<string, unknown>|undefined {
  if (isRecord(event.usage)) return event.usage;
  if (isRecord(event.info) && isRecord(event.info.last_token_usage)) return event.info.last_token_usage;
  return undefined;
}
function extractHarnessResult(event:Record<string,unknown>,serverName:string):{runId:string;usage:UsageRecord[];costs:CostComponent[];media:MediaOutput[]}|undefined {
  if(event.type!=='item.completed'||!isRecord(event.item))return undefined;
  const item=event.item;
  if(item.type!=='mcp_tool_call'||item.tool!=='route_task'||item.server!==serverName||!isRecord(item.result))return undefined;
  const result=isRecord(item.result.structured_content)?item.result.structured_content:isRecord(item.result.structuredContent)?item.result.structuredContent:item.result;
  if(typeof result.runId!=='string'||!/^[a-f0-9-]{36}$/.test(result.runId))return undefined;
  const usage=Array.isArray(result.usage)?result.usage.filter(isUsageRecord):[];
  const costs=Array.isArray(result.costComponents)?result.costComponents.filter(isCostComponent):[];
  const artifacts=Array.isArray(result.artifacts)?result.artifacts.filter(isRecord):[];
  const selectedHarnessId=typeof result.selectedHarnessId==='string'?result.selectedHarnessId:'unknown';
  const model=typeof result.selectedModelId==='string'?result.selectedModelId:undefined;
  const imageArtifacts=artifacts.filter(artifact=>artifact.type==='image');
  const media:MediaOutput[]=imageArtifacts.length?[{provider:selectedHarnessId==='fal-creative'?'fal':selectedHarnessId,model,kind:'image',count:imageArtifacts.length,requestIds:imageArtifacts.map(artifact=>artifact.providerRequestId).filter((value):value is string=>typeof value==='string')}]:[];
  return {runId:result.runId,usage,costs,media};
}
function isUsageRecord(value:unknown):value is UsageRecord {
  if(!isRecord(value)||value.schemaVersion!=='1.0'||typeof value.provider!=='string'||typeof value.source!=='string'||!isRecord(value.tokens))return false;
  return ['provider_reported','platform_estimated','manual_import','unavailable'].includes(String(value.measurement))&&['complete','partial','unavailable'].includes(String(value.completeness));
}
function isCostComponent(value:unknown):value is CostComponent {
  return isRecord(value)&&typeof value.provider==='string'&&typeof value.source==='string'&&['provider_reported','rate_estimate','unknown'].includes(String(value.status))&&(value.usd===undefined||validUsd(value.usd));
}
function count(record: Record<string, unknown>, keys: string[]): number|undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}
function assign<K extends keyof TokenCounters>(target:TokenCounters,key:K,value:TokenCounters[K]|undefined):void {if(value!==undefined)target[key]=value;}
function isRecord(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function validUsd(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= 0;}
