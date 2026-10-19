import {opendir,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {HarnessResult,UsageRecord} from '../domain/types.js';
import {validateResult} from '../domain/schemas.js';
import {RouterError} from '../domain/errors.js';

export interface PerformanceOptions {sortBy?:'time'|'tokens';taskType?:string;limit?:number}
export interface RoutePerformance {
  routeId:string;harnessId:string;modelId:string|null;modelIdentity:'reported'|'configured'|'mixed'|'unknown';taskType:string;
  attempts:number;completed:number;failed:number;cancelled:number;distinctTaskSpecs:number|null;unknownTaskSpecs:number;
  criteria:{allPassed:number;failed:number;unverified:number;notSupplied:number};
  timing:{medianTotalMs:number|null;p95TotalMs:number|null;medianExecutionMs:number|null;medianOverheadMs:number|null;sampleRuns:number};
  usage:{completeRuns:number;partialRuns:number;unavailableRuns:number;legacyRuns:number;medianTotalTokens:number|null;medianInputTokens:number|null;medianOutputTokens:number|null;medianCachedInputTokens:number|null};
  cost:{reportedSubtotalUsd:number;estimatedSubtotalUsd:number;unpricedRuns:number};
}
export interface PerformanceReport {
  schemaVersion:'1.0';scope:'router_and_worker_only';comparison:'observational_not_controlled';
  sortBy:'time'|'tokens';taskType:string|null;
  scan:{examined:number;included:number;invalid:number;unassigned:number;missingTaskMetadata:number;limited:boolean};
  routes:RoutePerformance[];notes:string[];
}
type Sample={result:HarnessResult;requirements:string[];caseKey:string|null;identity:'reported'|'configured'|'unknown'};
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const median=(values:number[])=>{if(!values.length)return null;const ordered=[...values].sort((a,b)=>a-b);const middle=Math.floor(ordered.length/2);return ordered.length%2?ordered[middle]!:(ordered[middle-1]!+ordered[middle]!)/2;};
const p95=(values:number[])=>{if(!values.length)return null;const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.ceil(ordered.length*.95)-1]!;};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
async function json(path:string):Promise<unknown>{
  const stat=await lstat(path);if(!stat.isFile()||stat.nlink!==1||stat.size>2*1024*1024)throw new Error('Unsafe or oversized result');
  return JSON.parse(await readFile(path,'utf8'));
}
function canonical(record:UsageRecord):boolean{
  // Pre-correction worker records share the old result schema; never rank their wrong counters as comparable.
  return record.source.endsWith('.canonical_v1')||['decisions_api','pi_session_stats'].includes(record.source);
}
function fullUsage(records:UsageRecord[]):boolean{
  return records.length>0&&records.every(record=>{
    const t=record.tokens;
    return canonical(record)&&record.completeness==='complete'&&record.measurement==='provider_reported'
      &&[t.inputTokens,t.outputTokens,t.totalTokens].every(value=>Number.isSafeInteger(value)&&number(value))
      &&t.totalTokens===t.inputTokens!+t.outputTokens!
      &&(t.cachedInputTokens===undefined||t.cachedInputTokens<=t.inputTokens!)
      &&(t.cacheWriteInputTokens===undefined||t.cacheWriteInputTokens<=t.inputTokens!)
      &&(t.cachedInputTokens===undefined||t.cacheWriteInputTokens===undefined||t.cachedInputTokens+t.cacheWriteInputTokens<=t.inputTokens!)
      &&(t.reasoningOutputTokens===undefined||t.reasoningOutputTokens<=t.outputTokens!);
  });
}
function summarize(samples:Sample[]):RoutePerformance{
  const first=samples[0]!.result;const requirements=samples[0]!.requirements;
  const result:RoutePerformance={routeId:first.selectedRouteId!,harnessId:first.selectedHarnessId??first.selectedRouteId!.split(':')[0]!,modelId:first.selectedModelId??null,modelIdentity:'unknown',taskType:requirements.join('+')||'unknown',attempts:samples.length,completed:0,failed:0,cancelled:0,distinctTaskSpecs:samples.every(s=>s.caseKey!==null)?new Set(samples.map(s=>s.caseKey)).size:null,unknownTaskSpecs:samples.filter(s=>s.caseKey===null).length,criteria:{allPassed:0,failed:0,unverified:0,notSupplied:0},timing:{medianTotalMs:null,p95TotalMs:null,medianExecutionMs:null,medianOverheadMs:null,sampleRuns:0},usage:{completeRuns:0,partialRuns:0,unavailableRuns:0,legacyRuns:0,medianTotalTokens:null,medianInputTokens:null,medianOutputTokens:null,medianCachedInputTokens:null},cost:{reportedSubtotalUsd:0,estimatedSubtotalUsd:0,unpricedRuns:0}};
  const identities=new Set(samples.map(s=>s.identity));result.modelIdentity=identities.size===1?samples[0]!.identity:'mixed';
  const elapsed:number[]=[],execution:number[]=[],overhead:number[]=[],input:number[]=[],output:number[]=[],total:number[]=[],cached:number[]=[];
  for(const sample of samples){
    const run=sample.result;const completed=run.status==='completed';
    if(completed){result.completed++;elapsed.push(run.timing.totalMs);if(number(run.timing.executionMs)){execution.push(run.timing.executionMs);overhead.push(Math.max(0,run.timing.totalMs-run.timing.executionMs));}}
    else if(run.status==='cancelled')result.cancelled++;else result.failed++;
    const criteria=run.criterionResults??[];
    if(!criteria.length)result.criteria.notSupplied++;
    else if(criteria.some(c=>c.status==='failed'))result.criteria.failed++;
    else if(criteria.some(c=>c.status==='unverified')||!completed)result.criteria.unverified++;
    else result.criteria.allPassed++;
    const records=run.usage??[];
    const full=fullUsage(records);
    if(records.some(r=>!canonical(r)))result.usage.legacyRuns++;
    if(full){
      result.usage.completeRuns++;
      // Token medians describe completed runs only; failures remain in coverage/counts and costs.
      if(completed){input.push(records.reduce((n,r)=>n+r.tokens.inputTokens!,0));output.push(records.reduce((n,r)=>n+r.tokens.outputTokens!,0));total.push(records.reduce((n,r)=>n+r.tokens.totalTokens!,0));if(records.every(r=>number(r.tokens.cachedInputTokens)))cached.push(records.reduce((n,r)=>n+r.tokens.cachedInputTokens!,0));}
    }else if(records.some(r=>Object.keys(r.tokens).length>0))result.usage.partialRuns++;else result.usage.unavailableRuns++;
    let unpriced=run.cost.status==='unknown';
    const components=run.costComponents??[];
    if(!components.length){
      if(run.cost.status==='known'&&number(run.cost.usd))result.cost.reportedSubtotalUsd+=run.cost.usd;
      else if(run.cost.status==='estimated'&&number(run.cost.usd))result.cost.estimatedSubtotalUsd+=run.cost.usd;
      else if(run.cost.status!=='not_applicable')unpriced=true;
    }
    for(const component of components){
      if(component.status==='unknown')unpriced=true;
      else if(number(component.usd)){if(component.status==='provider_reported')result.cost.reportedSubtotalUsd+=component.usd;else result.cost.estimatedSubtotalUsd+=component.usd;}else unpriced=true;
    }
    if(unpriced)result.cost.unpricedRuns++;
  }
  result.timing={medianTotalMs:median(elapsed),p95TotalMs:p95(elapsed),medianExecutionMs:median(execution),medianOverheadMs:median(overhead),sampleRuns:elapsed.length};
  Object.assign(result.usage,{medianTotalTokens:median(total),medianInputTokens:median(input),medianOutputTokens:median(output),medianCachedInputTokens:median(cached)});
  return result;
}
/** Read bounded saved result/task files only. No trace/prompt output, runtime probes, ledger mutation or provider calls. */
export async function readPerformanceReport(root:string,options:PerformanceOptions={}):Promise<PerformanceReport>{
  const sortBy=options.sortBy??'time';const limit=options.limit??1000;const taskType=options.taskType?.trim().toLowerCase();
  if(!['time','tokens'].includes(sortBy)||!Number.isInteger(limit)||limit<1||limit>5000||taskType!==undefined&&!/^[a-z0-9_.-]{1,80}$/.test(taskType))throw new RouterError('invalid_performance_options','Use sort time|tokens, a task type, and limit 1..5000');
  const report:PerformanceReport={schemaVersion:'1.0',scope:'router_and_worker_only',comparison:'observational_not_controlled',sortBy,taskType:taskType??null,scan:{examined:0,included:0,invalid:0,unassigned:0,missingTaskMetadata:0,limited:false},routes:[],notes:[
    'Includes router/worker counters only; host conversation usage is not captured.',
    'Groups contain observational task mixtures. Lower time/tokens does not prove equivalent quality or controlled savings.',
    'Criteria passes include technical checks; they are not independent semantic grading.',
    'Token medians use complete canonical provider counters from completed runs. Missing or legacy counters are not zeros.',
    'Cached tokens remain part of input; reasoning remains part of output. Tokenizers differ across models.',
    'A bounded directory sample is not guaranteed to be the latest runs. USD subtotals exclude unknown charges.',
  ]};
  const paths:string[]=[];
  try{for await(const entry of await opendir(root)){if(!entry.isDirectory()||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(entry.name))continue;if(paths.length===limit){report.scan.limited=true;break;}paths.push(join(root,entry.name));}}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return report;throw new RouterError('performance_unavailable','Could not read local run history');}
  const groups=new Map<string,Sample[]>();
  // Eight concurrent reads bound memory and avoid one filesystem operation per serialized run.
  for(let offset=0;offset<paths.length;offset+=8){
    const batch=await Promise.all(paths.slice(offset,offset+8).map(async directory=>{
      report.scan.examined++;
      try{
        const raw=object(await json(join(directory,'result.json')));
        let task:Record<string,unknown>={};let hasTaskMetadata=false;
        try{task=object(await json(join(directory,'task.json')));hasTaskMetadata=typeof task.prompt==='string'&&Array.isArray(task.requirements)&&task.requirements.every(r=>typeof r==='string');}catch{}
        if(!hasTaskMetadata)report.scan.missingTaskMetadata++;
        if(raw.schemaVersion==='1.0'){raw.schemaVersion='1.1';raw.criterionResults=[];}
        validateResult(raw);const result=raw;
        if(!result.selectedRouteId||result.selectedHarnessId==='native'||result.status==='defer_to_host'){report.scan.unassigned++;return;}
        const requirements=Array.isArray(task.requirements)?[...new Set(task.requirements.filter((r):r is string=>typeof r==='string').map(r=>r.trim().toLowerCase()))].sort():[];
        if(taskType&&!requirements.includes(taskType))return;
        const provenance=object(result.structuredOutput?.provenance);
        const identity=typeof provenance.reportedModel==='string'?'reported' as const:typeof provenance.requestedModel==='string'?'configured' as const:'unknown' as const;
        const caseKey=hasTaskMetadata?createHash('sha256').update(JSON.stringify([task.prompt,task.context,requirements,provenance.baselineFingerprint])).digest('hex'):null;
        const key=JSON.stringify([result.selectedRouteId,result.selectedModelId??null,requirements]);
        return {key,sample:{result,requirements,caseKey,identity}};
      }catch{report.scan.invalid++;return;}
    }));
    for(const item of batch){if(!item)continue;report.scan.included++;const group=groups.get(item.key)??[];group.push(item.sample);groups.set(item.key,group);}
  }
  report.routes=[...groups.values()].map(summarize).sort((a,b)=>{
    const left=sortBy==='tokens'?a.usage.medianTotalTokens:a.timing.medianTotalMs;const right=sortBy==='tokens'?b.usage.medianTotalTokens:b.timing.medianTotalMs;
    return (left??Infinity)-(right??Infinity)||a.taskType.localeCompare(b.taskType)||a.routeId.localeCompare(b.routeId)||String(a.modelId).localeCompare(String(b.modelId));
  });
  return report;
}
export function formatPerformanceReport(report:PerformanceReport):string{
  const text=['Local route measurements (router + worker; host usage excluded).','Observational samples; time/token order is not a quality or savings guarantee.'];
  if(!report.routes.length)text.push('No matching saved execution results. Run an explicitly authorized task to collect measurements.');
  else{
    text.push('route | model | task | completed/attempts | criteria passed | median ms | median tokens | complete usage');
    const value=(n:number|null)=>n===null?'unavailable':String(Math.round(n));
    const safe=(s:string)=>s.replace(/[\x00-\x1f\x7f|]/g,'?');
    for(const row of report.routes)text.push([safe(row.routeId),safe(`${row.modelId??'unreported'} [${row.modelIdentity}]`),safe(row.taskType),`${row.completed}/${row.attempts}`,`${row.criteria.allPassed}/${row.attempts}`,value(row.timing.medianTotalMs),value(row.usage.medianTotalTokens),`${row.usage.completeRuns}/${row.attempts}`].join(' | '));
  }
  text.push(`Scanned ${report.scan.examined}; invalid ${report.scan.invalid}; unassigned ${report.scan.unassigned}; missing task metadata ${report.scan.missingTaskMetadata}; limited ${report.scan.limited}.`);
  return text.join('\n')+'\n';
}
