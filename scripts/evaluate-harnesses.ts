import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRouter} from '../src/create-router.js';
import {loadConfig} from '../src/config.js';
import {loadRegistry} from '../src/registry/loader.js';
import {redact,RunTrace} from '../src/observability/trace.js';
import {assertArtifactPath,verifyImage} from '../src/observability/artifacts.js';
import {validateResult} from '../src/domain/schemas.js';
import {evaluateOfflineEligibility,parseEvaluationSet,scoreStep,summarizeEvaluation,type ArtifactVerification,type EvaluationPath,type EvaluationStep} from '../src/evaluation/evaluator.js';
import type {Artifact,HarnessResult,HarnessTask,Cost,ExecutionContext} from '../src/domain/types.js';

type Args={mode:'offline'|'live';caseId?:string;path?:EvaluationPath;maxCostUsd?:number;repeat:number};
function parseArgs(argv:string[]):Args {
  const values=new Map<string,string>();
  for(let i=0;i<argv.length;i++){
    const key=argv[i]!;
    if(!key.startsWith('--'))throw new Error(`Unexpected argument: ${key}`);
    const value=argv[i+1];if(!value||value.startsWith('--'))throw new Error(`Missing value for ${key}`);
    if(values.has(key))throw new Error(`Duplicate argument: ${key}`);values.set(key,value);i++;
  }
  const mode=values.get('--mode')??'offline';
  if(mode!=='offline'&&mode!=='live')throw new Error('--mode must be offline or live');
  const repeat=Number(values.get('--repeat')??1);
  if(!Number.isInteger(repeat)||repeat<1||repeat>10)throw new Error('--repeat must be an integer from 1 to 10');
  const path=values.get('--path');
  if(path!==undefined&&path!=='direct'&&path!=='router')throw new Error('--path must be direct or router');
  const maxRaw=values.get('--max-cost-usd');const maxCostUsd=maxRaw===undefined?undefined:Number(maxRaw);
  if(maxCostUsd!==undefined&&(!Number.isFinite(maxCostUsd)||maxCostUsd<=0))throw new Error('--max-cost-usd must be a positive finite number');
  const caseId=values.get('--case');
  const allowed=new Set(['--mode','--case','--path','--max-cost-usd','--repeat']);
  for(const key of values.keys())if(!allowed.has(key))throw new Error(`Unknown argument: ${key}`);
  if(mode==='live'&&(!caseId||!path||maxCostUsd===undefined))throw new Error('Live mode requires --case, --path direct|router, and --max-cost-usd. It runs one named case only.');
  if(mode==='offline'&&(caseId||path||maxCostUsd!==undefined||repeat!==1))throw new Error('Offline mode accepts no case, path, cap, or repeat options.');
  return {mode,caseId,path:path as EvaluationPath|undefined,maxCostUsd,repeat};
}

function taskFor(step:EvaluationStep,taskId:string,capUsd:number,previous?:HarnessResult):HarnessTask {
  const context={...(step.task.context??{})};
  if(step.inheritPreviousObservations&&previous){
    context.websiteObservations=previous.structuredOutput?.websiteObservations;
    context.referenceArtifacts=previous.artifacts;
  }
  return {
    schemaVersion:'1.0',taskId,prompt:step.task.prompt,requirements:[...step.task.requirements],requiredCapabilities:[...step.task.requiredCapabilities],
    acceptanceCriteria:[...step.task.acceptanceCriteria],desiredOutput:step.task.desiredOutput,
    ...(Object.keys(context).length?{context}:{}),...(step.task.allowedDomains?{allowedDomains:[...step.task.allowedDomains]}:{}),
    maxCostUsd:Math.min(step.task.maxCostUsd??capUsd,capUsd),...(step.task.timeoutMs?{timeoutMs:step.task.timeoutMs}:{}),
    allowPaidExecution:step.task.allowPaidExecution??false,...(step.inheritPreviousObservations&&previous?{parentRunId:previous.runId}:{}),
  };
}

async function independentlyVerifyArtifacts(result:HarnessResult,runDirectory:string,signal:AbortSignal) {
  const metadata:Record<string,ArtifactVerification>={};
  for(const artifact of result.artifacts){
    if(artifact.type!=='image'&&artifact.type!=='screenshot')continue;
    if(!artifact.path){artifact.verified=false;continue;}
    try{
      const path=await assertArtifactPath(artifact.path,runDirectory);const found=await verifyImage(path,{signal});
      artifact.path=path;artifact.verified=true;artifact.mimeType=found.mimeType;
      metadata[path]={width:found.width,height:found.height,mimeType:found.mimeType,sha256:found.sha256};
    }catch(error){artifact.verified=false;metadata[artifact.path]={verificationError:error instanceof Error?error.message:'Unknown artifact verification failure'};}
  }
  return metadata;
}

function aggregateCost(costs:Cost[]):Cost {
  const known=costs.filter(cost=>cost.status==='known'||cost.status==='estimated');
  if(costs.some(cost=>cost.status==='unknown'))return {status:'unknown',...(known.length?{usd:known.reduce((total,cost)=>total+(cost.usd??0),0)}:{}),details:'At least one cost is unknown; usd, when present, is only the known or estimated subtotal. Inspect its run trace before retrying.'};
  if(known.length)return {status:known.some(cost=>cost.status==='estimated')?'estimated':'known',usd:known.reduce((total,cost)=>total+(cost.usd??0),0),details:'Sum of reported known or estimated step costs; not an invoice.'};
  return {status:'not_applicable',usd:0,details:'No provider cost was reported.'};
}

async function invokeDirect(options:{router:Awaited<ReturnType<typeof createRouter>>;step:EvaluationStep;task:HarnessTask;remainingUsd:number}):Promise<{result:HarnessResult;metadata:Record<string,ArtifactVerification>}> {
  const {router,step,task,remainingUsd}=options;
  const expected=step.expected.direct;
  if(!expected?.selectedHarnessId)throw new Error(`Step ${step.id} has no direct harness path`);
  const adapter=router.adapters.find(candidate=>candidate.id===expected.selectedHarnessId);
  if(!adapter)throw new Error(`Direct harness is not registered: ${expected.selectedHarnessId}`);
  const health=await adapter.health();if(!health.available)throw new Error(`Direct harness ${adapter.id} is unavailable: ${health.reason??'unknown reason'}`);
  const list=await router.listHarnesses();const registry=await loadRegistry(router.config.registryPath);
  const {getEligibleRoutes}=await import('../src/registry/eligibility.js');
  const filtered=getEligibleRoutes(task,registry,{...list.health,[adapter.id]:health},{allowPaid:router.config.allowPaid,dryRun:router.config.dryRun,remainingBudgetUsd:Math.min(remainingUsd,router.ledger.remainingUsd),allowedDomains:router.config.allowedDomains,credentials:list.credentials});
  const candidate=filtered.eligible.find(item=>item.harness.id===adapter.id);
  if(!candidate)throw new Error(`Direct harness ${adapter.id} is not eligible for this case: ${filtered.excluded.map(item=>`${item.id}=${item.reason}`).join(', ')}`);

  const runId=randomUUID();const trace=new RunTrace(router.config.artifactsDir,runId);const signal=AbortSignal.timeout(Math.min(task.timeoutMs??candidate.harness.default_timeout_ms,300_000));
  await trace.save('task.json',task);
  const budget=router.ledger.forRun(runId,Math.min(remainingUsd,task.maxCostUsd??router.config.perTaskUsd));
  const started=performance.now();let output;
  try{
    const context:ExecutionContext={runId,routeId:candidate.route.id,route:candidate.route,modelProfileId:candidate.route.agent_model_profile??undefined,budgetUsd:budget.remainingUsd,signal,artifactsDir:trace.directory,trace,budget};
    output=await adapter.execute(task,context);
  }catch(error){
    const message=error instanceof Error?error.message:'Unknown direct harness error';
    output={status:'failed' as const,summary:message,artifacts:[],cost:router.ledger.costForRun(runId),error:{code:'direct_harness_failed',message,retryable:false}};
  }
  const outputCostComponent=output.cost.status==='not_applicable'?[]:[{provider:adapter.id==='fal-creative'?'fal':health.provider??adapter.id,model:output.selectedModelId??health.modelId??undefined,source:(output.cost.details??'Direct harness adapter cost').slice(0,200),status:output.cost.status==='known'?'provider_reported' as const:output.cost.status==='estimated'?'rate_estimate' as const:'unknown' as const,...(output.cost.usd===undefined?{}:{usd:output.cost.usd}),...(output.artifacts.find(artifact=>artifact.providerRequestId)?.providerRequestId?{requestId:output.artifacts.find(artifact=>artifact.providerRequestId)!.providerRequestId}:{})}];
  const result:HarnessResult={schemaVersion:'1.2',runId,taskId:task.taskId,status:output.status,selectedRouteId:candidate.route.id,selectedHarnessId:adapter.id,selectedModelId:output.selectedModelId??health.modelId??null,summary:output.summary,structuredOutput:output.structuredOutput,artifacts:output.artifacts.map((artifact:Artifact)=>({...artifact})),criterionResults:[],timing:{totalMs:performance.now()-started,executionMs:output.timing?.executionMs??performance.now()-started,handoffMs:output.timing?.handoffMs,verificationMs:0},cost:output.cost,usage:output.usage??[],costComponents:output.costComponents??outputCostComponent,error:output.error,tracePath:trace.path};
  const verificationStarted=performance.now();const metadata=await independentlyVerifyArtifacts(result,trace.directory,signal);result.timing.verificationMs=performance.now()-verificationStarted;
  const {evaluateCriteria}=await import('../src/verification/criteria.js');result.criterionResults=evaluateCriteria(task,result);
  validateResult(result);await trace.save('result.json',result);await trace.save('direct-result.json',result);
  return {result,metadata};
}

async function invokeStep(options:{router:Awaited<ReturnType<typeof createRouter>>;step:EvaluationStep;path:EvaluationPath;task:HarnessTask;remainingUsd:number}):Promise<{result:HarnessResult;metadata:Record<string,ArtifactVerification>}> {
  const {router,step,path,task,remainingUsd}=options;
  if(path==='direct'){
    return invokeDirect({router,step,task,remainingUsd});
  }
  const result=await router.routeTask(task);
  const runDirectory=dirname(result.tracePath??join(router.config.artifactsDir,result.runId,'events.jsonl'));
  return {result,metadata:await independentlyVerifyArtifacts(result,runDirectory,AbortSignal.timeout(30_000))};
}

async function writeReport(root:string,id:string,report:unknown) {
  const directory=join(root,'evaluations',id);await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,'summary.json');await writeFile(path,JSON.stringify(redact(report),null,2)+'\n',{mode:0o600});
  return {path};
}

const args=parseArgs(process.argv.slice(2));const config=loadConfig();
const fixture=JSON.parse(await readFile(join(config.root,'fixtures/harness-evaluation-tasks.json'),'utf8'));
const evaluationSet=parseEvaluationSet(fixture);
const evalId=randomUUID();

if(args.mode==='offline'){
  const registry=await loadRegistry(config.registryPath);
  const health={'pi-browser':{available:true,provider:'openai-codex'},'fal-creative':{available:true,provider:'offline-fixture'},native:{available:true,provider:'host'}};
  const report=evaluateOfflineEligibility(evaluationSet,registry,health);
  const saved=await writeReport(config.artifactsDir,evalId,{evaluationId:evalId,generatedAt:new Date().toISOString(),...report,limits:'Offline mode validates fixture contracts and deterministic route eligibility only. It does not invoke Decisions or execute any harness.'});
  console.log(JSON.stringify({...report,evaluationId:evalId,reportPath:saved.path},null,2));
  if(report.failed)process.exitCode=1;
}else{
  const selected=evaluationSet.cases.find(item=>item.id===args.caseId);
  if(!selected)throw new Error(`Unknown evaluation case: ${args.caseId}`);
  const router=await createRouter();
  try{
    const cap=args.maxCostUsd!;
    if(!router.config.allowPaid||router.config.dryRun)throw new Error('Live eval blocked: set ROUTER_ALLOW_PAID_RUNS=true and ROUTER_DRY_RUN=false first.');
    if(cap>router.ledger.remainingUsd)throw new Error(`Requested eval cap $${cap.toFixed(4)} exceeds current authorized session remainder $${router.ledger.remainingUsd.toFixed(4)}.`);
    if(args.repeat>1&&selected.steps.some(step=>step.task.allowPaidExecution))console.error('Live repetitions are explicit and sequential; the run stops after any failure or unresolved charge.');
    if(args.path==='direct'&&selected.steps.some(step=>!step.expected.direct))throw new Error(`Case ${selected.id} does not support direct harness evaluation.`);
    const caseResults=[] as Array<{caseId:string;path:EvaluationPath;verifiedSuccess:boolean;checks:ReturnType<typeof scoreStep>;cost:Cost;repeat:number;steps:unknown[];criterionResults:unknown[];humanImageReview?:unknown}>;
    let stop=false;let evaluationSpentUsd=0;let unresolvedEvaluationCost=false;
    for(let repeat=1;repeat<=args.repeat&&!stop;repeat++){
      const stepRows:unknown[]=[];const allChecks:ReturnType<typeof scoreStep>=[];const costs:Cost[]=[];const criteria:unknown[]=[];let previous:HarnessResult|undefined;
      for(const step of selected.steps){
        const expectation=step.expected[args.path!];if(!expectation)throw new Error(`Case ${selected.id} step ${step.id} has no ${args.path} execution path.`);
        if(unresolvedEvaluationCost){stop=true;break;}
        const remaining=Math.max(0,cap-evaluationSpentUsd);if(remaining<=0){stop=true;break;}
        const task=taskFor(step,`eval-${selected.id}-${repeat}-${step.id}-${randomUUID()}`,Math.min(remaining,router.config.perTaskUsd),previous);
        let execution:{result:HarnessResult;metadata:Record<string,ArtifactVerification>};
        try{execution=await invokeStep({router,step,path:args.path!,task,remainingUsd:remaining});}
        catch(error){
          const message=error instanceof Error?error.message:'Unknown evaluator execution failure';
          execution={result:{schemaVersion:'1.1',runId:randomUUID(),taskId:task.taskId,status:'failed',selectedRouteId:null,selectedHarnessId:null,artifacts:[],criterionResults:[],timing:{totalMs:0},cost:{status:'unknown',details:'Execution setup failed; inspect provider trace before retrying.'},error:{code:'evaluation_execution_failed',message,retryable:false}},metadata:{}};
        }
        const checks=scoreStep({step,path:args.path!,result:execution.result,artifactMetadata:execution.metadata});
        allChecks.push(...checks);costs.push(execution.result.cost);criteria.push(...execution.result.criterionResults);
        if(execution.result.cost.status==='known'||execution.result.cost.status==='estimated')evaluationSpentUsd+=execution.result.cost.usd??0;
        if(execution.result.cost.status==='unknown'&&execution.result.status!=='completed')unresolvedEvaluationCost=true;
        stepRows.push({stepId:step.id,runId:execution.result.runId,status:execution.result.status,selectedHarnessId:execution.result.selectedHarnessId,selectedRouteId:execution.result.selectedRouteId,checks,criterionResults:execution.result.criterionResults,timing:execution.result.timing,cost:execution.result.cost,error:execution.result.error,tracePath:execution.result.tracePath,artifacts:execution.result.artifacts});
        previous=execution.result;
        if(execution.result.status!=='completed'&&expectation.status==='completed'){stop=true;break;}
        if(execution.result.cost.status==='unknown'&&execution.result.status!=='completed'){stop=true;break;}
        if(checks.some(check=>check.status==='failed')){stop=true;break;}
      }
      const expectedSteps=selected.steps.filter(step=>step.expected[args.path!]).length;
      const noFailedCriteria=criteria.every(item=>(item as {status?:string}).status!=='failed');
      const casePassed=stepRows.length===expectedSteps&&allChecks.length>0&&allChecks.every(check=>check.status==='passed')&&noFailedCriteria;
      const hasImage=selected.steps.some(step=>step.task.desiredOutput==='image');
      const humanImageReview=hasImage?{status:'pending',rating:null as number|null,notes:null as string|null,scale:'1-5',dimensions:selected.humanImageReview?.dimensions??['brief adherence','legibility','composition','visual coherence'],artifactPaths:stepRows.flatMap((row)=>((row as {artifacts?:Artifact[]}).artifacts??[]).filter(artifact=>artifact.type==='image').map(artifact=>artifact.path).filter(Boolean))}:undefined;
      caseResults.push({caseId:selected.id,path:args.path!,repeat,verifiedSuccess:casePassed,checks:allChecks,cost:aggregateCost(costs),steps:stepRows,criterionResults:criteria,...(humanImageReview?{humanImageReview}:{})});
      if(!casePassed||costs.some(cost=>cost.status==='unknown'))stop=true;
    }
    const summary=summarizeEvaluation(caseResults.map(row=>({...row,criteria:row.criterionResults as Array<{status:'passed'|'failed'|'unverified'}>})));
    const report={schemaVersion:'1.0',evaluationId:evalId,generatedAt:new Date().toISOString(),mode:'live-single-case',caseId:selected.id,path:args.path,requestedRepeats:args.repeat,completedRepeats:caseResults.length,maxCostUsd:cap,results:caseResults,summary,limits:'Results describe these captured runs only, not a calibrated success probability or comparative advantage. Unknown cost blocks further repetitions. No automatic retries are performed.'};
    const saved=await writeReport(config.artifactsDir,evalId,report);
    console.log(JSON.stringify({...report,reportPath:saved.path},null,2));
    if(caseResults.length!==args.repeat||caseResults.some(row=>!row.verifiedSuccess))process.exitCode=1;
  }finally{await router.close();}
}
