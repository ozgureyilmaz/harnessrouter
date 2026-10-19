import {mkdir,open,readdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {BenchmarkRunRecord,UsageRecord,CostComponent} from '../domain/types.js';
import {validateBenchmarkRun,validateResult} from '../domain/schemas.js';
import {aggregateBenchmarkRecords,normalizeUsageRecord,normalizePiUsage} from './metering.js';

export function benchmarkDirectory(artifactsDir:string):string {return join(resolve(artifactsDir),'benchmark');}

export async function createDesktopBenchmarkRun(artifactsDir:string,input:{caseId:string;arm:string;repetition:number;prompt:string;model:string;profile?:string;threadId?:string;durationMs?:number;status?:BenchmarkRunRecord['status'];sourceLabel:string;counters:unknown;harnessRunIds?:string[]}):Promise<BenchmarkRunRecord> {
  if(!input.prompt.trim()||!input.model||!input.sourceLabel.trim())throw new Error('Desktop record requires prompt, model, and usage source label.');
  const record:BenchmarkRunRecord={schemaVersion:'1.0',benchmarkRunId:randomUUID(),caseId:input.caseId,arm:input.arm,repetition:input.repetition,
    promptHash:createHash('sha256').update(input.prompt).digest('hex'),startedAt:new Date().toISOString(),timestampSource:'import_time',...(input.durationMs===undefined?{}:{durationMs:input.durationMs}),
    status:input.status??'completed',outcome:'ungraded',codex:{model:input.model,modelSource:'manual_import',...(input.profile?{profile:input.profile}:{}),...(input.threadId?{threadId:input.threadId}:{})},
    harnessRunIds:input.harnessRunIds??[],usage:[normalizeUsageRecord({provider:'openai-codex',model:input.model,source:'codex_app_import',measurement:'manual_import',counters:input.counters,details:`Manually imported from ${input.sourceLabel}`})],costComponents:[]};
  await saveBenchmarkRun(artifactsDir,record);
  return record;
}

export async function saveBenchmarkRun(artifactsDir:string,record:BenchmarkRunRecord):Promise<string> {
  validateBenchmarkRun(record);
  const directory=join(benchmarkDirectory(artifactsDir),'runs');
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,`${record.benchmarkRunId}.json`);
  const file=await open(path,'wx',0o600);
  try {await file.writeFile(`${JSON.stringify(record,null,2)}\n`,'utf8');await file.sync();}
  catch(error){await file.close();await unlink(path).catch(()=>{});throw error;}
  await file.close();
  return path;
}

export async function updateBenchmarkRun(artifactsDir:string,record:BenchmarkRunRecord):Promise<string> {
  validateBenchmarkRun(record);
  const directory=join(benchmarkDirectory(artifactsDir),'runs');
  const path=join(directory,`${record.benchmarkRunId}.json`);
  const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp,`${JSON.stringify(record,null,2)}\n`,{mode:0o600});
  try{await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});throw error;}
  return path;
}

export async function listBenchmarkRuns(artifactsDir:string):Promise<BenchmarkRunRecord[]> {
  const directory=join(benchmarkDirectory(artifactsDir),'runs');
  const names=await readdir(directory).catch((error:NodeJS.ErrnoException)=>error.code==='ENOENT'?[]:Promise.reject(error));
  const records:BenchmarkRunRecord[]=[];
  for(const name of names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).sort()) {
    const record:unknown=JSON.parse(await readFile(join(directory,name),'utf8'));
    validateBenchmarkRun(record);
    records.push(record);
  }
  return records;
}

export async function importUsageIntoBenchmarkRun(artifactsDir:string,benchmarkRunId:string,usage:UsageRecord):Promise<BenchmarkRunRecord> {
  if(!/^[a-f0-9-]{36}$/.test(benchmarkRunId))throw new Error('Invalid benchmark run ID.');
  const path=join(benchmarkDirectory(artifactsDir),'runs',`${benchmarkRunId}.json`);
  const record:unknown=JSON.parse(await readFile(path,'utf8'));
  validateBenchmarkRun(record);
  const existing=record.usage.find(item=>item.source==='codex_app_import');
  if(existing)throw new Error('Desktop Codex usage was already imported for this run.');
  const prior=record.usage.filter(item=>item.source==='codex_cli_jsonl');
  const evidenceDir=join(benchmarkDirectory(artifactsDir),'evidence');
  await mkdir(evidenceDir,{recursive:true,mode:0o700});
  const evidencePath=`benchmark/evidence/${benchmarkRunId}-host-import-${randomUUID()}.json`;
  await writeFile(join(artifactsDir,evidencePath),JSON.stringify({importedAt:new Date().toISOString(),previousHostUsage:prior,importedUsage:usage},null,2)+'\n',{mode:0o600,flag:'wx'});
  const updated={...record,usage:[...record.usage.filter(item=>item.source!=='codex_cli_jsonl'),{...usage,evidenceRef:evidencePath}],usageImportHistory:[...(record.usageImportHistory??[]),{importedAt:new Date().toISOString(),evidencePath}]};
  validateBenchmarkRun(updated);
  await updateBenchmarkRun(artifactsDir,updated);
  return updated;
}

export async function gradeBenchmarkRun(artifactsDir:string,benchmarkRunId:string,outcome:'verified_success'|'verified_failure',evidence:string):Promise<BenchmarkRunRecord> {
  if(!/^[a-f0-9-]{36}$/.test(benchmarkRunId))throw new Error('Invalid benchmark run ID.');
  const safeEvidence=evidence.trim().slice(0,1000);
  if(!safeEvidence)throw new Error('Grade evidence is required.');
  const path=join(benchmarkDirectory(artifactsDir),'runs',`${benchmarkRunId}.json`);
  const record:unknown=JSON.parse(await readFile(path,'utf8'));
  validateBenchmarkRun(record);
  if(outcome==='verified_success'&&record.status!=='completed')throw new Error('Only completed executions can be graded verified_success.');
  if(record.outcome!=='ungraded')throw new Error('This benchmark run already has a verified outcome.');
  const updated={...record,outcome,gradeEvidence:safeEvidence,gradedAt:new Date().toISOString()};
  validateBenchmarkRun(updated);
  await updateBenchmarkRun(artifactsDir,updated);
  return updated;
}

/** Direct Codex tools may have their own bills; import receipts or rate estimates locally. */
export async function importBenchmarkCosts(artifactsDir:string,benchmarkRunId:string,components:CostComponent[]):Promise<BenchmarkRunRecord> {
  if(!/^[a-f0-9-]{36}$/.test(benchmarkRunId)||!components.length)throw new Error('A valid run ID and at least one cost component are required.');
  const path=join(benchmarkDirectory(artifactsDir),'runs',`${benchmarkRunId}.json`);
  const record:unknown=JSON.parse(await readFile(path,'utf8'));validateBenchmarkRun(record);
  const seen=new Set(record.costComponents.filter(item=>item.requestId).map(item=>`${item.provider}/${item.requestId}`));
  for(const component of components){
    if(component.status!=='unknown'&&(component.usd===undefined||!Number.isFinite(component.usd)||component.usd<0))throw new Error('Reported or estimated cost requires a nonnegative USD value.');
    if(component.requestId){const key=`${component.provider}/${component.requestId}`;if(seen.has(key))throw new Error('This provider request cost was already imported.');seen.add(key);}
  }
  const updated={...record,costComponents:[...record.costComponents,...components]};validateBenchmarkRun(updated);
  await updateBenchmarkRun(artifactsDir,updated);return updated;
}

/** Reviewed direct-arm image counts are explicit imports, separate from text tokens. */
export async function importBenchmarkMedia(artifactsDir:string,benchmarkRunId:string,media:NonNullable<BenchmarkRunRecord['mediaOutputs']>,evidence:string):Promise<BenchmarkRunRecord> {
  if(!/^[a-f0-9-]{36}$/.test(benchmarkRunId)||!media.length||!evidence.trim()||evidence.length>2000)throw new Error('A valid run ID, media records and review evidence are required.');
  const path=join(benchmarkDirectory(artifactsDir),'runs',`${benchmarkRunId}.json`);
  const record:unknown=JSON.parse(await readFile(path,'utf8'));validateBenchmarkRun(record);
  if(record.mediaImportHistory?.length)throw new Error('Media units already imported for this run; include all direct outputs in one import.');
  const importedAt=new Date().toISOString();
  const evidenceDirectory=join(benchmarkDirectory(artifactsDir),'evidence');await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
  const evidencePath=relative(artifactsDir,join(evidenceDirectory,`${benchmarkRunId}-media-import.json`));
  const updated={...record,mediaOutputs:[...(record.mediaOutputs??[]),...media],mediaImportHistory:[{importedAt,evidencePath}]};validateBenchmarkRun(updated);
  await writeFile(join(artifactsDir,evidencePath),JSON.stringify({importedAt,measurement:'manual_import',evidence,media},null,2)+'\n',{mode:0o600,flag:'wx'});
  await updateBenchmarkRun(artifactsDir,updated);return updated;
}

export async function linkHarnessRuns(artifactsDir:string,benchmarkRunId:string,runIds:readonly string[]):Promise<BenchmarkRunRecord> {
  if(!/^[a-f0-9-]{36}$/.test(benchmarkRunId)||runIds.some(id=>!/^[a-f0-9-]{36}$/.test(id)))throw new Error('Invalid benchmark or HarnessRouter run ID.');
  const path=join(benchmarkDirectory(artifactsDir),'runs',`${benchmarkRunId}.json`);
  const record:unknown=JSON.parse(await readFile(path,'utf8'));
  validateBenchmarkRun(record);
  const updated={...record,harnessRunIds:[...new Set([...record.harnessRunIds,...runIds])]};
  validateBenchmarkRun(updated);
  await updateBenchmarkRun(artifactsDir,updated);
  return updated;
}

export async function writeBenchmarkSummary(artifactsDir:string,summary:unknown):Promise<string> {
  const directory=benchmarkDirectory(artifactsDir);
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,'summary.json');
  const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp,`${JSON.stringify(summary,null,2)}\n`,{mode:0o600});
  try{await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});throw error;}
  return path;
}

export async function buildBenchmarkReport(artifactsDir:string):Promise<Record<string,unknown>> {
  const records=await listBenchmarkRuns(artifactsDir);
  const missingHarnessRunIds:string[]=[];const runWarnings:Array<{benchmarkRunId:string;message:string}>=[];let linkedHarnessRuns=0;
  const owners=new Map<string,string>();
  const enriched:BenchmarkRunRecord[]=[];
  for(const record of records){
    const usage=[...record.usage];const costComponents=[...record.costComponents];const mediaOutputs=[...(record.mediaOutputs??[])];
    for(const harnessRunId of record.harnessRunIds){
      const previousOwner=owners.get(harnessRunId);
      if(previousOwner&&previousOwner!==record.benchmarkRunId)runWarnings.push({benchmarkRunId:record.benchmarkRunId,message:`Harness run ${harnessRunId} is also linked to ${previousOwner}; cached retrieval is not a fresh benchmark execution.`});
      owners.set(harnessRunId,record.benchmarkRunId);
      const usageStart=usage.length;
      const resultPath=join(resolve(artifactsDir),harnessRunId,'result.json');
      let result:unknown;
      try{result=JSON.parse(await readFile(resultPath,'utf8'));}
      catch{
        missingHarnessRunIds.push(harnessRunId);
        usage.push(normalizeUsageRecord({provider:'harnessrouter',source:'linked_harness_result',measurement:'unavailable',details:`Linked run ${harnessRunId} could not be read.`}));
        costComponents.push({provider:'harnessrouter',source:'Linked HarnessResult missing',status:'unknown'});
        continue;
      }
      if(!isRecord(result)){
        runWarnings.push({benchmarkRunId:record.benchmarkRunId,message:`Linked run ${harnessRunId} had an invalid result.`});
        usage.push(normalizeUsageRecord({provider:'harnessrouter',source:'linked_harness_result',measurement:'unavailable',details:'Linked run result was invalid.'}));
        costComponents.push({provider:'harnessrouter',source:'Invalid linked HarnessResult',status:'unknown'});
        continue;
      }
      if(result.schemaVersion==='1.1'||result.schemaVersion==='1.2'){
        try{validateResult(result);}catch{
          runWarnings.push({benchmarkRunId:record.benchmarkRunId,message:`Linked run ${harnessRunId} failed result schema validation.`});
          costComponents.push({provider:'harnessrouter',source:'Invalid linked result schema',status:'unknown'});
          usage.push(normalizeUsageRecord({provider:'harnessrouter',source:'linked_harness_result',measurement:'unavailable'}));continue;
        }
      }
      linkedHarnessRuns++;
      const runUsage=Array.isArray(result.usage)?result.usage.filter(isUsageRecord):[];
      usage.push(...runUsage);
      const runCosts=Array.isArray(result.costComponents)?result.costComponents.filter(isCostComponent):[];
      costComponents.push(...runCosts);
      const harness=typeof result.selectedHarnessId==='string'?result.selectedHarnessId:'unknown';
      const model=typeof result.selectedModelId==='string'?result.selectedModelId:undefined;
      const artifacts=Array.isArray(result.artifacts)?result.artifacts.filter(isRecord):[];
      const images=artifacts.filter(artifact=>artifact.type==='image');
      if(images.length)mediaOutputs.push({provider:harness==='fal-creative'?'fal':harness,...(model?{model}:{}),kind:'image',count:images.length,requestIds:images.map(item=>item.providerRequestId).filter((id):id is string=>typeof id==='string')});
      if(!runUsage.length&&result.schemaVersion!=='1.2'){
        const events=await readFile(join(resolve(artifactsDir),harnessRunId,'events.jsonl'),'utf8').catch(()=>undefined);
        if(events){
          for(const line of events.split(/\r?\n/)){
            let event:unknown;try{event=JSON.parse(line);}catch{continue;}
            if(!isRecord(event)||!isRecord(event.data))continue;
            const data=event.data;
            if(['decision.completed','decision.invalid_response','decision.refused','decision.failed'].includes(String(event.type))){
              const counters=isRecord(data.usage)?data.usage:undefined;
              usage.push(normalizeUsageRecord({provider:'openai',model:typeof data.model==='string'?data.model:'gpt-6-luna',source:'legacy_decision_trace',measurement:counters?'provider_reported':'unavailable',counters}));
            }
            if(event.type==='pi_agent_completed'||event.type==='pi_agent_failed'){
              const value=data.usage;
              if(isUsageRecord(value))usage.push(value);
              else usage.push(normalizePiUsage({provider:typeof data.provider==='string'?data.provider:'openai-codex',model:typeof data.modelId==='string'?data.modelId:model,source:'legacy_pi_trace',counters:value}));
            }
          }
        }
      }
      if(!usage.slice(usageStart).some(item=>item.source==='pi_session_stats'||item.source==='legacy_pi_trace')&&harness==='pi-browser'){
        const output=isRecord(result.structuredOutput)?result.structuredOutput:{};
        const legacy=output.providerReportedUsage;
        usage.push(isRecord(legacy)&&legacy.inputTokens!==undefined?normalizeUsageRecord({provider:'openai-codex',model,source:'legacy_pi_result',measurement:'provider_reported',counters:legacy}):normalizePiUsage({provider:'openai-codex',model,source:'legacy_pi_result',counters:legacy}));
      }
      if(!runCosts.length&&result.schemaVersion!=='1.2'&&isRecord(result.cost)&&result.cost.status!=='not_applicable'){
        const cost=result.cost;const status=cost.status==='known'?'provider_reported':cost.status==='estimated'?'rate_estimate':'unknown';
        costComponents.push({provider:'legacy-harnessrouter-total',source:(typeof cost.details==='string'?cost.details:'Legacy aggregate HarnessResult cost').slice(0,200),status,...(typeof cost.usd==='number'?{usd:cost.usd}:{})});
      }
    }
    // Subscription/provider usage without a matching cost remains explicitly
    // unknown. A known fal subtotal must not imply complete task USD coverage.
    for(const item of usage){
      if(item.provider==='harnessrouter')continue;
      if(!costComponents.some(component=>component.provider===item.provider&&component.model===item.model)){
        costComponents.push({provider:item.provider,...(item.model?{model:item.model}:{}),source:'Usage without a returned per-task USD charge',status:'unknown'});
      }
    }
    const effectiveCosts:CostComponent[]=[];const costIndices=new Map<string,number>();
    const priority={provider_reported:3,rate_estimate:2,unknown:1};
    for(const component of costComponents){
      const key=component.requestId?`${component.provider}/${component.requestId}`:undefined;
      const index=key?costIndices.get(key):undefined;
      if(index===undefined){if(key)costIndices.set(key,effectiveCosts.length);effectiveCosts.push(component);}
      else if(priority[component.status]>priority[effectiveCosts[index]!.status])effectiveCosts[index]=component;
    }
    enriched.push({...record,usage,costComponents:effectiveCosts,mediaOutputs});
  }
  const summary=aggregateBenchmarkRecords(enriched);
  return {...summary,runs:enriched,linkedHarnessRuns,missingHarnessRunIds:[...new Set(missingHarnessRunIds)],runWarnings,
    metricDefinitions:{tokens:'Observed counters; input includes cached input, and reasoning is part of output. Missing values remain absent.',means:'Means use tasks with observed counters, not every attempted task. Check sample counts, completeness and measurement provenance before comparing.',successRate:'Overall verifiedSuccessRate remains null while any run is ungraded; gradedSuccessRate describes the reviewed subset.',timing:'Completed execution latency includes ungraded completions; it is not verified-success latency.'},
    costAccounting:{subscriptionUsdAllocated:false,note:'Codex and Pi subscription usage is reported in token records. Subscription fees are not allocated per task; per-request USD remains unknown unless a provider reports it.'}};
}

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function isUsageRecord(value:unknown):value is UsageRecord {
  if(!isRecord(value)||value.schemaVersion!=='1.0'||typeof value.provider!=='string'||typeof value.source!=='string'||!isRecord(value.tokens))return false;
  return ['provider_reported','platform_estimated','manual_import','unavailable'].includes(String(value.measurement))&&['complete','partial','unavailable'].includes(String(value.completeness));
}
function isCostComponent(value:unknown):value is BenchmarkRunRecord['costComponents'][number] {
  return isRecord(value)&&typeof value.provider==='string'&&typeof value.source==='string'&&['provider_reported','rate_estimate','unknown'].includes(String(value.status));
}
