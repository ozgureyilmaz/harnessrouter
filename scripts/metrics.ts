import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
const config=loadConfig();const entries=await readdir(config.artifactsDir).catch(()=>[]);
const runs:Record<string,unknown>[]=[];const decisions:Record<string,unknown>[]=[];const policyChecks:unknown[]=[];
const read=async(path:string)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return undefined;}};
for(const name of entries){if(!/^[a-f0-9-]{36}$/.test(name))continue;
  const directory=join(config.artifactsDir,name);
  for(const filename of ['result.json','harness-smoke.json','baseline.json','direct-comparison.json']){
    const record=await read(join(directory,filename));if(!record)continue;
    const result=record.result??record;
    if(filename==='result.json'&&!result.selectedHarnessId){policyChecks.push({runId:name,status:result.status,error:result.error});continue;}
    runs.push({runId:name,evidenceFile:join(directory,filename),kind:filename,...record});
  }
  try{for(const line of (await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n')){
    const event=JSON.parse(line);if(event.type==='decision.completed'||event.type==='decision.failed')decisions.push({runId:name,event:event.type,...event.data});
  }}catch{}
}
const executionRuns=runs.filter(r=>r.kind==='baseline.json'||r.kind==='harness-smoke.json'||r.selectedHarnessId!=='native');
const successful=executionRuns.filter(r=>((r.result as {status?:string}|undefined)?.status??r.status??(r.kind==='baseline.json'?'completed':undefined))==='completed');
const budget=await read(join(config.artifactsDir,'budget.json'));
const estimatedProviderFeesUsd=budget?.entries.reduce((total:number,e:{cost?:{status?:string;usd?:number}})=>total+(e.cost?.status==='estimated'?(e.cost.usd??0):0),0)??0;
const baseline=runs.find(r=>r.kind==='baseline.json');
const labelEvaluation=await read(join(config.root,'demo/live-routing-evaluation.json'));
const nativeVerification=await read(join(config.root,'demo/native-mcp-verification.json'));
const browser=runs.find(r=>r.runId==='9f372976-bce1-49a4-bdf4-cc1eb68136cf');
const creative=runs.find(r=>r.runId==='d73bceb2-70fa-4693-86a8-02e3150bb667');
const firstEvents=await readFile(join(config.artifactsDir,'9f372976-bce1-49a4-bdf4-cc1eb68136cf','events.jsonl'),'utf8').catch(()=>undefined);
const lastEvents=await readFile(join(config.artifactsDir,'d73bceb2-70fa-4693-86a8-02e3150bb667','events.jsonl'),'utf8').catch(()=>undefined);
const first=firstEvents?.trim().split('\n').map(s=>JSON.parse(s)).find(e=>e.type==='request');
const last=lastEvents?.trim().split('\n').map(s=>JSON.parse(s)).find(e=>e.type==='result');
const metrics={generatedAt:new Date().toISOString(),
  mode:'ACTUAL_CAPTURED_LIVE_EVIDENCE',
  liveExecutionAttempts:executionRuns.length,verifiedCompletedExecutions:successful.length,verifiedExecutionSuccessRate:executionRuns.length?successful.length/executionRuns.length:null,
  decisions:{attempts:decisions.length,validSelections:decisions.filter(d=>d.event==='decision.completed').length,failures:decisions.filter(d=>d.event==='decision.failed').length,records:decisions},
  policyChecks,runs,
  composite:browser&&creative?{browserRunId:browser.runId,creativeRunId:creative.runId,routerProcessingSumMs:Number((browser.timing as {totalMs:number}).totalMs)+Number((creative.timing as {totalMs:number}).totalMs),workflowWallFromFirstRouterRequestToFinalResultMs:first&&last?Date.parse(last.at)-Date.parse(first.at):null,nativeToolCatalogVisible:Boolean(nativeVerification?.catalogVisible),transport:nativeVerification?.catalogVisible?'Current reopened Codex chat native MCP':'Current Codex chat invoking stdio MCP SDK bridge; no nested Codex'}:null,
  nativeSessionMcp:nativeVerification??{catalogVisible:false,status:'pending'},
  cost:{authorizedCapUsd:config.sessionUsd,committedUpperBoundUsd:budget?.committedUsd,estimatedProviderFeesUsd,providerInvoicedFees:'unknown',piOAuthPerRequestUsd:'unknown',unresolvedReservations:budget?.entries.filter((e:{cost?:{status:string}})=>e.cost?.status==='unknown').length??0},
  baselineComparison:baseline?{baselineRunId:baseline.runId,specialistRunId:baseline.referenceRunId,baselineTiming:baseline.timing,specialistTiming:baseline.specialistTiming,limits:baseline.comparisonLimits}:null,
  routingFixtureEvaluation:labelEvaluation?{cases:labelEvaluation.cases,correct:labelEvaluation.correct,liveDecisionCases:labelEvaluation.liveDecisionCases,liveDecisionCorrect:labelEvaluation.liveDecisionCorrect,liveDecisionLabelAccuracy:labelEvaluation.liveDecisionLabelAccuracy,confusionMatrix:labelEvaluation.confusionMatrix,limits:labelEvaluation.limits}:null,specializationEfficiencyGain:'not established',artisticQuality:'not graded',
  timingDefinition:'executionMs is adapter wall time and includes handoffMs/internal verification; do not add handoffMs again. verificationMs is the separate outer verifier. composite processing sum excludes host preparation and CLI startup.'};
await mkdir(join(config.root,'demo'),{recursive:true});await writeFile(join(config.root,'demo/metrics.json'),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify({evidence:'demo/metrics.json',attempts:metrics.liveExecutionAttempts,verified:metrics.verifiedCompletedExecutions,decisions:metrics.decisions.validSelections,composite:metrics.composite,cost:metrics.cost,baseline:metrics.baselineComparison},null,2));
