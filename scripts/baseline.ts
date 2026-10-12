import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../src/config.js';
import {loadRegistry} from '../src/registry/loader.js';
import {RunTrace} from '../src/observability/trace.js';
import {BudgetLedger} from '../src/observability/budget.js';
import {createFalQueuePort} from '../src/harnesses/creative/fal-queue.js';
import {planCreativeTask} from '../src/harnesses/creative/planner.js';
import {downloadImage,verifyImage} from '../src/observability/artifacts.js';
import {validateTask,validateResult} from '../src/domain/schemas.js';
import type {HarnessTask,HarnessResult} from '../src/domain/types.js';
const config=loadConfig();const reference=process.argv[2];
if(!/^[a-f0-9-]{36}$/.test(reference??''))throw new Error('Provide the completed specialist run UUID');
if(!config.apiKey||!config.falKey||!config.allowPaid||config.dryRun)throw new Error('Baseline requires configured keys and existing paid authorization');
const source=join(config.artifactsDir,reference);const task:HarnessTask=JSON.parse(await readFile(join(source,'task.json'),'utf8'));validateTask(task);
const specialist:HarnessResult=JSON.parse(await readFile(join(source,'result.json'),'utf8'));validateResult(specialist);
if(specialist.status!=='completed'||specialist.selectedHarnessId!=='fal-creative')throw new Error('Reference must be a completed fal-creative routed run');
const registry=await loadRegistry(config.registryPath);const route=registry.harnesses.find(h=>h.id==='fal-creative')!.routes.find(r=>r.id===specialist.selectedRouteId)!;
const runId=randomUUID();const trace=new RunTrace(config.artifactsDir,runId);await mkdir(trace.directory,{recursive:true,mode:0o700});
const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);const budget=ledger.forRun(runId,.25);const signal=AbortSignal.timeout(180000);
let requestId:string|undefined;let reservation:string|undefined;
try{
  const planned=planCreativeTask(task,{runId,routeId:route.id,route,budgetUsd:budget.remainingUsd,signal,artifactsDir:trace.directory,trace,budget});if(!planned.ok)throw new Error(planned.message);
  const plan=planned.plan;
  // Matched model, dimensions, seed, steps and generation constraints. Only prompt
  // specialization differs: direct baseline serializes measured CSS facts plainly.
  const style=(task.context?.websiteObservations as {visualStyle?:unknown}|undefined)?.visualStyle;
  const prompt=task.prompt+(style?'\nObserved CSS and layout facts: '+JSON.stringify(style):'');
  const input={...plan.input,prompt};
  await trace.save('baseline-input.json',{reference,modelId:plan.profile.modelId,input,method:'Direct fal queue with matched model/seed/dimensions/parameters; no creative prompt specialization'});
  const queue=createFalQueuePort({apiKey:config.falKey,signal});reservation=await budget.reserve(plan.estimatedCostUsd,'Matched direct fal baseline');
  const started=performance.now();const submitted=await queue.submit(plan.profile.modelId,input,signal);requestId=submitted.requestId;const submitMs=performance.now()-started;
  await trace.event('baseline.submitted',{modelId:plan.profile.modelId,requestId});await trace.save('baseline-request.json',{modelId:plan.profile.modelId,requestId});
  for(;;){const status=await queue.status(plan.profile.modelId,requestId,signal) as {status?:string};await trace.event('baseline.status',status);if(status.status==='COMPLETED')break;
    if(!['IN_QUEUE','IN_PROGRESS'].includes(status.status??''))throw new Error('Unexpected queue status');
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,750);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});}
  const raw=await queue.result(plan.profile.modelId,requestId,signal) as {data?:{images?:{url?:string}[]}};
  const url=raw.data?.images?.[0]?.url;if(typeof url!=='string')throw new Error('Baseline returned no image URL');
  const generationMs=performance.now()-started-submitMs;const verificationStart=performance.now();const path=join(trace.directory,'baseline.png');
  await downloadImage(url,path,signal);const artifact=await verifyImage(path,{signal,expectedRatio:plan.expectedAspectRatio});const verificationMs=performance.now()-verificationStart;
  const cost={status:'estimated' as const,usd:plan.estimatedCostUsd,details:'Published per-MP rate estimate; invoice not returned'};await budget.settle(reservation,cost);
  const result={mode:'LIVE_MATCHED_DIRECT_FAL_BASELINE',runId,referenceRunId:reference,modelId:plan.profile.modelId,requestId,artifacts:[{path,url,verified:true,...artifact}],timing:{submitMs,generationMs,verificationMs,totalMs:performance.now()-started},cost,specialistTiming:specialist.timing,specialistCost:specialist.cost,comparisonLimits:'Single sequential trial; provider queues and cache vary. Artistic quality ungraded; no efficiency gain established.'};
  await trace.save('baseline.json',result);console.log(JSON.stringify(result,null,2));
}catch(e){if(reservation)await budget.settle(reservation,{status:'unknown'});await trace.save('baseline-failure.json',{requestId,error:e instanceof Error?e.message:'unknown',cost:'unknown',retry:'No automatic resubmission'});throw e;}
finally{await ledger.close();}
