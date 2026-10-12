// Direct Codex control: thin official fal queue call; no routing or creative planner.
import {createFalClient} from '@fal-ai/client';
import type {Flux2Input} from '@fal-ai/client/endpoints';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../src/config.js';
import {BudgetLedger} from '../src/observability/budget.js';
import {RunTrace} from '../src/observability/trace.js';
import {downloadImage,verifyImage} from '../src/observability/artifacts.js';
const config=loadConfig();const file=process.argv[2];const label=process.argv[3];
if(!file||!label||!/^[a-z0-9-]+$/.test(label))throw new Error('Provide input JSON path and safe trial label');
if(!config.allowPaid||config.dryRun||!config.falKey)throw new Error('Existing paid authorization and FAL_KEY required');
const input:Flux2Input=JSON.parse(await readFile(file,'utf8'));
if(!input.prompt||input.num_images!==1||input.image_size==='landscape_16_9'||typeof input.image_size!=='object'||input.image_size.width!==1024||input.image_size.height!==576||input.output_format!=='png'||input.enable_safety_checker!==true)throw new Error('Expected one safe 1024x576 PNG generation');
const runId=randomUUID();const trace=new RunTrace(config.artifactsDir,runId);await mkdir(trace.directory,{recursive:true});
const comparisonDir=join(config.artifactsDir,'paired-agentation-2026-10-12');await mkdir(comparisonDir,{recursive:true});
if(existsSync(join(comparisonDir,label+'.json')))throw new Error('Trial label already has a saved outcome; use a new label for an intentional new trial');
// A repeated invocation after a crash must not silently submit another paid job.
await writeFile(join(comparisonDir,label+'.claim.json'),JSON.stringify({runId,inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex')}),{flag:'wx',mode:0o600});
const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);const budget=ledger.forRun(runId,Math.min(.25,config.perTaskUsd));const signal=AbortSignal.timeout(180000);
let attempted=false;let requestId:string|undefined;let reservation:string|undefined;
const client=createFalClient({credentials:config.falKey,retry:{maxRetries:0},fetch:async(request,init)=>{
  const url=typeof request==='string'?request:request instanceof URL?request.href:request.url;
  if((init?.method??'GET').toUpperCase()==='POST'&&new URL(url).hostname==='queue.fal.run'){
    if(attempted)throw new Error('Repeated paid POST blocked');attempted=true;
  }
  return fetch(request,{...init,signal});
}});
try{
  await trace.save('direct-input.json',{condition:'direct_current_codex_fal',modelId:'fal-ai/flux-2',input,inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex')});
  reservation=await budget.reserve(.012,'Paired direct Codex FLUX.2 control');const start=performance.now();
  const submitted=await client.queue.submit('fal-ai/flux-2',{input,headers:{'X-Fal-No-Retry':'1'},abortSignal:signal});requestId=submitted.request_id;
  const submitMs=performance.now()-start;await trace.save('request.json',{requestId,modelId:'fal-ai/flux-2'});await trace.event('direct.submitted',{requestId});
  let polls=0;
  for(;;){const state=await client.queue.status('fal-ai/flux-2',{requestId,logs:false,abortSignal:signal});polls++;await trace.event('direct.status',state);if(state.status==='COMPLETED')break;
    await new Promise<void>((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,750);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});});
  }
  const result=await client.queue.result('fal-ai/flux-2',{requestId,abortSignal:signal});await trace.save('provider-result.json',result);
  const generationAndPollingMs=performance.now()-start-submitMs;const verifyStart=performance.now();const path=join(trace.directory,'direct-image.png');
  const image=result.data.images?.[0];if(!image?.url)throw new Error('No output image');
  await downloadImage(image.url,path,signal);const verified=await verifyImage(path,{signal,expectedRatio:16/9});
  const cost={status:'estimated' as const,usd:.012,details:'Published per-MP upper estimate; invoice unavailable'};await budget.settle(reservation,cost);
  const record={condition:'direct_current_codex_fal',label,runId,status:'completed',modelId:'fal-ai/flux-2',providerRequestId:requestId,inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),artifact:{path,url:image.url,verified:true,...verified},timing:{submitMs,generationAndPollingMs,downloadAndVerificationMs:performance.now()-verifyStart,totalMs:performance.now()-start},polls,submissions:1,cost,hostCodexUsd:'unknown',tracePath:trace.path};
  await trace.save('direct-comparison.json',record);await writeFile(join(comparisonDir,label+'.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record,null,2));
}catch(error){if(reservation)await budget.settle(reservation,{status:attempted?'unknown':'not_applicable',...(attempted?{}:{usd:0})});
  const failure={condition:'direct_current_codex_fal',label,runId,status:'failed',requestId,error:error instanceof Error?error.message:'unknown',automaticResubmission:false};await trace.save('direct-comparison.json',failure);await writeFile(join(comparisonDir,label+'.json'),JSON.stringify(failure,null,2));throw new Error('Direct fal trial failed; inspect sanitized saved trace');
}finally{await ledger.close();}
