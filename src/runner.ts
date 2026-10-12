import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import type {HarnessAdapter,HarnessTask,HarnessResult,DecisionTrace,Health,UsageRecord,CostComponent} from './domain/types.js';
import {RouterError,checkAbort} from './domain/errors.js';
import {validateTask,validateResult,validateTrace} from './domain/schemas.js';
import type {RouterConfig} from './config.js';
import {loadRegistry} from './registry/loader.js';
import {getEligibleRoutes} from './registry/eligibility.js';
import {DecisionsClient} from './routing/decisions.js';
import {RunTrace,taskFingerprint,redact} from './observability/trace.js';
import {BudgetLedger} from './observability/budget.js';
import {assertArtifactPath,verifyImage,validatePublicUrl} from './observability/artifacts.js';
import {planCreativeTask} from './harnesses/creative/planner.js';
import {evaluateCriteria,unverifiedCriteria} from './verification/criteria.js';
import {normalizeUsageRecord} from './observability/metering.js';
export class HarnessRouter {
  private active=new Map<string,AbortController>();
  private pending=new Map<string,Promise<HarnessResult>>();
  constructor(readonly config:RouterConfig,readonly adapters:HarnessAdapter[],readonly ledger:BudgetLedger,private decisions=new DecisionsClient({apiKey:config.apiKey,model:config.decisionModel,timeoutMs:config.decisionTimeoutMs,allowPaid:config.allowPaid,dryRun:config.dryRun})) {}
  async health():Promise<Record<string,Health>> {
    const result:Record<string,Health>={native:{available:true}};
    await Promise.all(this.adapters.map(async adapter=>{
      try{result[adapter.id]=await adapter.health();}
      catch{result[adapter.id]={available:false,reason:'health_check_failed'};}
    }));return result;
  }
  async listHarnesses(){return {registry:await loadRegistry(this.config.registryPath),health:await this.health(),policy:{dryRun:this.config.dryRun,allowPaid:this.config.allowPaid,remainingBudgetUsd:this.ledger.remainingUsd,allowedDomains:this.config.allowedDomains},credentials:{openai:!!this.config.apiKey,fal:!!this.config.falKey}};}
  routeTask(input:unknown,hostSignal?:AbortSignal):Promise<HarnessResult> {
    validateTask(input);
    const key=createHash('sha256').update(input.taskId).digest('hex');
    const task=structuredClone(input);
    // Compare pending inputs too; taskId must never alias two different operations.
    const existing=this.pending.get(key);if(existing)return existing.then(old=>{
      return this.getRun(old.runId).then(async()=>{
        const prior=JSON.parse(await readFile(join(this.config.artifactsDir,'tasks',key+'.json'),'utf8'));
        if(prior.fingerprint!==createHash('sha256').update(JSON.stringify(task)).digest('hex'))throw new RouterError('idempotency_conflict','taskId already used for a different task');
        return old;
      });
    });
    const run=this.execute(task,key,hostSignal).finally(()=>this.pending.delete(key));this.pending.set(key,run);return run;
  }
  private async execute(task:HarnessTask,key:string,hostSignal?:AbortSignal):Promise<HarnessResult> {
    const runId=randomUUID();const trace=new RunTrace(this.config.artifactsDir,runId);
    const controller=new AbortController();const signal=controller.signal;
    const configuredTimeout=task.requirements.some(r=>['browser','screenshot','public_site_research'].includes(r))?this.config.piTaskTimeoutMs:this.config.falTaskTimeoutMs;
    const timeout=Math.min(task.timeoutMs??configuredTimeout,configuredTimeout,300000);
    const timer=setTimeout(()=>controller.abort(new RouterError('timeout','Task timed out')),timeout);
    const abort=()=>controller.abort(hostSignal?.reason);hostSignal?.addEventListener('abort',abort,{once:true});
    if(hostSignal?.aborted)abort();this.active.set(runId,controller);
    let selectedRouteId:string|null=null;let selectedHarnessId:string|null=null;
    let selectedModelId:string|null=null;let decisionCost:HarnessResult['cost']={status:'not_applicable',usd:0};
    let decisionRequired=false;let decisionAttempted=false;let decisionMeteringObserved=false;
    const usageRecords:UsageRecord[]=[];const costComponents:CostComponent[]=[];
    const decisionTraceSink={event:async(type:string,data?:unknown)=>{
      if(type==='decision.requested')decisionAttempted=true;
      if(['decision.completed','decision.invalid_response','decision.refused','decision.failed'].includes(type)) {
        decisionMeteringObserved=true;
        const eventData=isRecord(data)?data:{};
        const usage={...normalizeUsageRecord({provider:'openai',model:typeof eventData.model==='string'?eventData.model:this.config.decisionModel,source:'decisions_api',measurement:isRecord(eventData.usage)?'provider_reported':'unavailable',counters:eventData.usage,details:isRecord(eventData.usage)?undefined:'The Decisions response did not provide token usage.'}),evidenceRef:`events.jsonl:${type}`};
        usageRecords.push(usage);
        const providerCost=isRecord(eventData.cost)?eventData.cost:{};
        const status=providerCost.status==='estimated'?'rate_estimate':providerCost.status==='known'?'provider_reported':'unknown';
        costComponents.push({provider:'openai',model:typeof eventData.model==='string'?eventData.model:this.config.decisionModel,source:'OpenAI Decisions API',status,...(typeof providerCost.usd==='number'?{usd:providerCost.usd}:{}),...(typeof eventData.providerDecisionId==='string'?{requestId:eventData.providerDecisionId}:{}),...(typeof providerCost.details==='string'?{details:providerCost.details}:{})});
      }
      await trace.event(type,data);
    }};
    const timing:HarnessResult['timing']={totalMs:0};
    let executionStart:number|undefined;
    const decisionTrace:DecisionTrace={schemaVersion:'1.0',runId,eligibleRouteIds:[],decisionStatus:'no_candidates'};
    let result:HarnessResult|undefined;
    const fingerprint=createHash('sha256').update(JSON.stringify(task)).digest('hex');
    try {
      const indexDir=join(this.config.artifactsDir,'tasks');await mkdir(indexDir,{recursive:true,mode:0o700});
      const indexPath=join(indexDir,key+'.json');
      try {
        await writeFile(indexPath,JSON.stringify({runId,fingerprint}),{flag:'wx',mode:0o600});
      }catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
        const old=JSON.parse(await readFile(indexPath,'utf8'));
        if(old.fingerprint!==fingerprint)throw new RouterError('idempotency_conflict','taskId already used for a different task; use a new taskId');
        const oldResult=await this.getRun(old.runId);
        if('result' in oldResult && oldResult.result) return oldResult.result as HarnessResult;
        throw new RouterError('reconciliation_required',`Previous request ${old.runId} may still be executing; inspect get_run instead of resubmitting`);
      }
      await trace.event('request',{taskId:task.taskId,promptHash:taskFingerprint(task.prompt),promptLength:task.prompt.length,requirements:task.requirements,requiredCapabilities:task.requiredCapabilities??[],desiredOutput:task.desiredOutput,parentRunId:task.parentRunId,timeoutMs:timeout});
      await trace.save('task.json',task);
      await trace.save('status.json',{runId,status:'validating'});
      checkAbort(signal);
      if(task.requirements.some(r=>['browser','screenshot','public_site_research'].includes(r))) {
        if(typeof task.context?.url!=='string')throw new RouterError('invalid_browser_task','Browser task requires context.url');
        await validatePublicUrl(task.context.url,this.config.allowedDomains);
      }
      const registry=await loadRegistry(this.config.registryPath);
      const health=await this.health();checkAbort(signal);
      const effectiveBudget=Math.min(this.ledger.remainingUsd,task.maxCostUsd??this.config.perTaskUsd,this.config.perTaskUsd);
      const options=getEligibleRoutes(task,registry,health,{allowPaid:this.config.allowPaid,dryRun:this.config.dryRun,remainingBudgetUsd:effectiveBudget,allowedDomains:this.config.allowedDomains,credentials:{openai:!!this.config.apiKey,fal:!!this.config.falKey}});
      const budget=this.ledger.forRun(runId,Math.min(task.maxCostUsd??this.config.perTaskUsd,this.config.perTaskUsd));
      // Reuse the pure specialist planner to check all image constraints before offering a route.
      // This does not submit a job or reserve any provider spend.
      options.eligible=options.eligible.filter(candidate=>{
        if(candidate.harness.id!=='fal-creative')return true;
        const plan=planCreativeTask(task,{runId,routeId:candidate.route.id,route:candidate.route,budgetUsd:Math.max(0,budget.remainingUsd-.01),signal,artifactsDir:trace.directory,trace,budget});
        if(plan.ok)return true;
        options.excluded.push({id:candidate.route.id,reason:plan.code});return false;
      });
      if(!options.eligible.some(c=>c.harness.kind!=='host_defer')&&!task.requirements.some(r=>r==='coding'||r==='host_owned_tasks')) {
        options.eligible=options.eligible.filter(c=>c.harness.kind!=='host_defer');
        options.excluded.push({id:'native:defer',reason:'no_eligible_specialist_for_control_fallback'});
      }
      decisionTrace.eligibleRouteIds=options.eligible.map(c=>c.route.id);decisionTrace.excludedRoutes=options.excluded;
      await trace.event('eligibility',{...options,health});
      if(!options.eligible.length)throw new RouterError(options.excluded.some(r=>/paid|permission|approval/.test(r.reason))?'permission_required':'no_eligible_route','No authorized reachable route satisfies every task constraint');
      if(options.eligible.length===1&&options.eligible[0].harness.id==='native') {
        selectedRouteId=options.eligible[0].route.id;selectedHarnessId='native';
        await trace.event('host_control_defer',{reason:'No specialist delegation applies; no Decisions request sent'});
        const nativeResult:HarnessResult={schemaVersion:'1.2',runId,taskId:task.taskId,status:'defer_to_host',selectedRouteId,selectedHarnessId,selectedModelId:null,summary:'Task belongs to the current Codex host. No decision or external execution performed.',artifacts:[],criterionResults:unverifiedCriteria(task.acceptanceCriteria),timing:{totalMs:performance.now()-trace.start},cost:{status:'not_applicable',usd:0},usage:[],costComponents:[],tracePath:trace.path};
        validateResult(nativeResult);await trace.save('decision.json',{...decisionTrace,decisionStatus:'not_required',reason:'host_control_defer_no_decision'});await trace.save('result.json',nativeResult);await trace.save('status.json',{runId,status:nativeResult.status});return nativeResult;
      }
      let chosen=options.eligible[0]!;
      if(options.eligible.length===1) {
        selectedRouteId=chosen.route.id;
        decisionTrace.decisionStatus='not_required';
        decisionTrace.selectedRouteId=selectedRouteId;
        decisionTrace.reason='single_eligible_route';
        await trace.event('single_route_selected',{route:selectedRouteId});
      }else {
        decisionRequired=true;
        decisionCost={status:'unknown',details:'A decision attempt may incur provider fees; inspect decision trace and budget ledger'};
        const selected=await this.decisions.choose(task,options.eligible.map(c=>({value:c.route.id,description:c.route.description})),signal,decisionTraceSink,budget);
        selectedRouteId=selected.routeId;timing.decisionMs=selected.latencyMs;decisionCost=selected.cost;
        const selectedCandidate=options.eligible.find(c=>c.route.id===selected.routeId);
        if(!selectedCandidate)throw new RouterError('invalid_choice','Decision selected an unoffered route');
        chosen=selectedCandidate;
        Object.assign(decisionTrace,{decisionStatus:'selected',selectedRouteId,confidence:selected.confidence,probabilities:selected.probabilities,latencyMs:selected.latencyMs,decisionModel:selected.model,providerDecisionId:selected.providerDecisionId});
      }
      selectedHarnessId=chosen.harness.id;selectedModelId=chosen.route.generation_model_id??health[selectedHarnessId]?.modelId??null;
      validateTrace(decisionTrace);await trace.save('decision.json',decisionTrace);
      await trace.event('selected',{route:selectedRouteId,harness:selectedHarnessId,model:selectedModelId});
      if(selectedHarnessId==='native') {
        result={schemaVersion:'1.2',runId,taskId:task.taskId,status:'defer_to_host',selectedRouteId,selectedHarnessId,selectedModelId:null,summary:'Return this task to the current Codex session for host execution.',artifacts:[],criterionResults:unverifiedCriteria(task.acceptanceCriteria),timing,cost:decisionCost,usage:usageRecords,costComponents};
      }else {
        const adapter=this.adapters.find(a=>a.id===selectedHarnessId);if(!adapter)throw new RouterError('adapter_unavailable','Selected harness adapter is unavailable');
        // Recheck liveness after selection; no paid execution on a stale eligibility result.
        if(!(await adapter.health()).available)throw new RouterError('adapter_unavailable','Selected harness became unavailable');
        checkAbort(signal);await trace.save('status.json',{runId,status:'executing',selectedRouteId});
        executionStart=performance.now();
        const output=await adapter.execute({...task,timeoutMs:timeout},{runId,routeId:selectedRouteId,route:chosen.route,modelProfileId:chosen.route.agent_model_profile??undefined,budgetUsd:budget.remainingUsd,signal,artifactsDir:trace.directory,trace,budget});
        timing.executionMs=performance.now()-executionStart;timing.handoffMs=output.timing?.handoffMs??0;
        selectedModelId=output.selectedModelId??selectedModelId;
        usageRecords.push(...(output.usage??[]));
        const outputCost=output.cost;
        if(outputCost.status!=='not_applicable') {
          const status=outputCost.status==='known'?'provider_reported':outputCost.status==='estimated'?'rate_estimate':'unknown';
          const provider=selectedHarnessId==='pi-browser'?(health[selectedHarnessId]?.provider??'openai-codex'):selectedHarnessId==='fal-creative'?'fal':selectedHarnessId;
          const requestId=output.artifacts.find(artifact=>artifact.providerRequestId)?.providerRequestId??(typeof output.structuredOutput?.providerRequestId==='string'?output.structuredOutput.providerRequestId:undefined);
          costComponents.push({provider,model:output.selectedModelId??selectedModelId??undefined,source:(outputCost.details??'Harness provider cost').slice(0,200),status,...(outputCost.usd===undefined?{}:{usd:outputCost.usd}),...(requestId?{requestId}:{})});
        }
        await trace.save('adapter-output.json',output);
        const verificationStart=performance.now();
        if(output.status==='completed') {
          const needsImage=chosen.harness.id==='fal-creative';
          if(!output.artifacts.some(a=>a.type===(needsImage?'image':'screenshot')))throw new RouterError('artifact_missing','Harness completed without required artifact evidence');
          for(const artifact of output.artifacts){
            if(artifact.type==='image'||artifact.type==='screenshot'){
              if(!artifact.path)throw new RouterError('artifact_missing','Image result must have a local evidence file');
              const path=await assertArtifactPath(artifact.path,trace.directory);
              const expectedRatio=typeof output.structuredOutput?.expectedAspectRatio==='number'?output.structuredOutput.expectedAspectRatio:undefined;
              const evidence=await verifyImage(path,{signal,expectedRatio});artifact.mimeType=evidence.mimeType;artifact.verified=true;
              await trace.event('independent_verification',{path,...evidence});
            }
          }
        }
        timing.verificationMs=performance.now()-verificationStart;
        const aggregateCost=output.cost.status==='unknown'?{status:'unknown' as const,details:decisionCost.status==='not_applicable'?'Includes unpriced harness/provider accounting; no Decisions request was made':'Includes unpriced harness/provider accounting plus Decisions'}:{status:'estimated' as const,usd:(output.cost.usd??0)+(decisionCost.usd??0),details:'Verified published unit price estimate; not a provider invoice'};
        result={schemaVersion:'1.2',runId,taskId:task.taskId,status:output.status,selectedRouteId,selectedHarnessId,selectedModelId,summary:output.summary,structuredOutput:output.structuredOutput,artifacts:output.artifacts,criterionResults:[],timing,cost:aggregateCost,usage:usageRecords,costComponents,...(output.error?{error:output.error}:{})};
      }
    }catch(error) {
      const typed=signal.aborted?(signal.reason instanceof RouterError?signal.reason:new RouterError('cancelled','Task cancelled')):error instanceof RouterError?error:new RouterError('execution_failed',error instanceof Error?error.message:'Unknown execution error');
      if(executionStart!==undefined)timing.executionMs=performance.now()-executionStart;
      decisionTrace.decisionStatus=decisionTrace.decisionStatus==='not_required'?'not_required':selectedRouteId?'selected':typed.code==='decision_refused'?'refused':typed.code==='timeout'||typed.code==='decision_timeout'?'timeout':['invalid_choice','invalid_decision_response','invalid_decision'].includes(typed.code)?'invalid_response':typed.code==='no_eligible_route'?'no_candidates':'unavailable';
      decisionTrace.reason=typed.code;
      if(decisionRequired&&decisionAttempted&&!decisionMeteringObserved) {
        usageRecords.push(normalizeUsageRecord({provider:'openai',model:this.config.decisionModel,source:'decisions_api',measurement:'unavailable',details:'The Decisions attempt did not return token usage.'}));
        if(!['credential_missing:openai','paid_execution_not_authorized','dry_run_execution_disabled'].includes(typed.code))costComponents.push({provider:'openai',model:this.config.decisionModel,source:'OpenAI Decisions API attempt',status:'unknown',details:'Provider billing could not be reconciled from the response.'});
      }
      if(executionStart!==undefined&&selectedHarnessId&&selectedModelId&&!costComponents.some(component=>component.model===selectedModelId)) {
        const provider=selectedHarnessId==='pi-browser'?(await this.health())[selectedHarnessId]?.provider??'openai-codex':selectedHarnessId==='fal-creative'?'fal':selectedHarnessId;
        costComponents.push({provider,model:selectedModelId,source:'Harness execution failure',status:'unknown',details:'Execution may have incurred provider cost.'});
      }
      if(executionStart!==undefined&&selectedHarnessId==='pi-browser'&&!usageRecords.some(record=>record.source==='pi_session_stats'))usageRecords.push(normalizeUsageRecord({provider:'openai-codex',model:selectedModelId??undefined,source:'pi_session_stats',measurement:'unavailable',details:'Pi execution failed before session token usage could be collected.'}));
      await trace.event('failure',{code:typed.code,message:typed.message,retryable:typed.retryable});
      result={schemaVersion:'1.2',runId,taskId:task.taskId,status:typed.code==='permission_required'?'permission_required':typed.code==='cancelled'?'cancelled':['no_eligible_route','unsafe_url','domain_denied','invalid_browser_task'].includes(typed.code)?'rejected':'failed',selectedRouteId,selectedHarnessId,selectedModelId,artifacts:[],criterionResults:[],timing,cost:executionStart!==undefined?{status:'unknown',details:'Execution failed; a provider operation may still bill. Inspect trace/request ID before retry.'}:this.ledger.costForRun(runId),usage:usageRecords,costComponents,error:{code:typed.code,message:typed.message,retryable:typed.retryable}};
    }finally{clearTimeout(timer);hostSignal?.removeEventListener('abort',abort);this.active.delete(runId);}
    if(!result)throw new RouterError('internal_error','Missing result');
    result.criterionResults=evaluateCriteria(task,result);
    result.timing.totalMs=performance.now()-trace.start;result.tracePath=trace.path;
    validateResult(result);validateTrace(decisionTrace);
    await trace.save('decision.json',decisionTrace);await trace.save('result.json',result);await trace.save('status.json',{runId,status:result.status});
    await trace.event('result',{status:result.status,timing:result.timing,cost:result.cost});return redact(result) as HarnessResult;
  }
  async getRun(runId:string):Promise<Record<string,unknown>> {
    if(!/^[a-f0-9-]{36}$/.test(runId))throw new RouterError('invalid_run_id','runId must be a router-issued UUID');
    const directory=join(this.config.artifactsDir,runId);
    const read=async(name:string)=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
    const [savedResult,decision,status,task]=await Promise.all([read('result.json'),read('decision.json'),read('status.json'),read('task.json')]);
    if(!savedResult&&!status)throw new RouterError('run_not_found','Run not found');
    const result=savedResult?.schemaVersion==='1.0'?{...savedResult,schemaVersion:'1.1',criterionResults:unverifiedCriteria(Array.isArray(task?.acceptanceCriteria)?task.acceptanceCriteria:[])}:savedResult;
    return {runId,result,decision,status,tracePath:join(directory,'events.jsonl')};
  }
  cancel(runId:string){const active=this.active.get(runId);if(!active)return {runId,cancelled:false};active.abort(new RouterError('cancelled','Cancelled by host'));return {runId,cancelled:true};}
  async close(){for(const controller of this.active.values())controller.abort();await Promise.all(this.adapters.map(a=>a.close?.()));await Promise.allSettled(this.pending.values());await this.ledger.close();}
}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
