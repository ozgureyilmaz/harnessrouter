import {z} from 'zod';
import type {HarnessResult,Health,Registry} from '../domain/types.js';
import {getEligibleRoutes} from '../registry/eligibility.js';

const status = z.enum(['completed','failed','rejected','defer_to_host','permission_required','cancelled']);
const taskTemplate = z.object({
  prompt:z.string().min(1),
  requirements:z.array(z.string().min(1)).min(1),
  requiredCapabilities:z.array(z.string().min(1)).min(1),
  acceptanceCriteria:z.array(z.string().min(1)).min(1),
  desiredOutput:z.enum(['text','screenshot','image','video','mixed']),
  context:z.record(z.string(),z.unknown()).optional(),
  allowedDomains:z.array(z.string().min(1)).optional(),
  maxCostUsd:z.number().positive().optional(),
  timeoutMs:z.number().int().positive().optional(),
  allowPaidExecution:z.boolean().optional(),
}).strict();
const expected = z.object({status,selectedHarnessId:z.string().min(1).nullable().optional()}).strict();
const check = z.discriminatedUnion('type',[
  z.object({type:z.literal('verified_artifact'),artifactType:z.enum(['image','screenshot'])}).strict(),
  z.object({type:z.literal('browser_observation')}).strict(),
  z.object({type:z.literal('image_aspect_ratio'),ratio:z.number().positive(),tolerance:z.number().positive().max(.25).default(.025)}).strict(),
  z.object({type:z.literal('provider_request_id')}).strict(),
  z.object({type:z.literal('observations_consumed')}).strict(),
  z.object({type:z.literal('no_selected_route')}).strict(),
]);
const step = z.object({
  id:z.string().min(1),
  task:taskTemplate,
  inheritPreviousObservations:z.boolean().optional(),
  expected:z.object({direct:expected.optional(),router:expected}).strict(),
  checks:z.object({direct:z.array(check).optional(),router:z.array(check)}).strict(),
}).strict();
const evalCase = z.object({
  id:z.string().regex(/^[A-Z]+-\d{2}$/),
  category:z.enum(['browser','image','host_defer','unsupported','composed']),
  steps:z.array(step).min(1).max(2),
  humanImageReview:z.object({scale:z.tuple([z.literal(1),z.literal(5)]),dimensions:z.array(z.string().min(1)).min(1)}).strict().optional(),
}).strict().superRefine((item,ctx)=>{
  if(item.category==='composed'&&item.steps.length!==2)ctx.addIssue({code:'custom',message:'Composed evaluation cases must contain exactly two steps'});
  if(item.category!=='composed'&&item.steps.length!==1)ctx.addIssue({code:'custom',message:'Only composed evaluation cases may contain multiple steps'});
  if(item.category==='image'&&!item.humanImageReview)ctx.addIssue({code:'custom',message:'Image cases require a separate human quality review rubric'});
  for(const current of item.steps){
    if(current.inheritPreviousObservations&&item.category!=='composed')ctx.addIssue({code:'custom',message:'Observation handoff is valid only for composed cases'});
    if(current.expected.direct&&(!current.checks.direct||current.checks.direct.length===0))ctx.addIssue({code:'custom',message:'Directly evaluated steps require at least one direct acceptance check'});
    if(current.inheritPreviousObservations&&!current.expected.direct&&item.category==='composed')ctx.addIssue({code:'custom',message:'A composed step with inherited observations must support direct evaluation'});
  }
});

export const evaluationSetSchema=z.object({schemaVersion:z.literal('1.0'),cases:z.array(evalCase).length(24)}).strict().superRefine((set,ctx)=>{
  const ids=new Set<string>();
  for(const item of set.cases){if(ids.has(item.id))ctx.addIssue({code:'custom',message:`Duplicate evaluation case id: ${item.id}`});ids.add(item.id);}
  const counts={browser:0,image:0,host_defer:0,unsupported:0,composed:0};
  for(const item of set.cases)counts[item.category]++;
  if(Object.values(counts).some(count=>count===0))ctx.addIssue({code:'custom',message:'Evaluation set must cover all five case categories'});
});
export type EvaluationSet=z.infer<typeof evaluationSetSchema>;
export type EvaluationCase=EvaluationSet['cases'][number];
export type EvaluationStep=EvaluationCase['steps'][number];
export type EvaluationCheck=EvaluationStep['checks']['router'][number];
export type EvaluationPath='direct'|'router';
export type CheckResult={id:string;type:string;status:'passed'|'failed'|'unverified';evidence?:string};
export type ArtifactVerification= {width?:number;height?:number;mimeType?:string;sha256?:string;verificationError?:string};

export function parseEvaluationSet(value:unknown):EvaluationSet {
  const parsed=evaluationSetSchema.safeParse(value);
  if(!parsed.success)throw new Error(`Invalid harness evaluation set: ${parsed.error.issues.map(issue=>issue.message).join('; ')}`);
  return parsed.data;
}

export function evaluateOfflineEligibility(set:EvaluationSet,registry:Registry,health:Record<string,Health>) {
  const rows:Array<{caseId:string;stepId:string;path:EvaluationPath;passed:boolean;expectedHarnessId:string|null;eligibleHarnessIds:string[];failure?:string}> = [];
  for(const item of set.cases)for(const current of item.steps){
    const task={schemaVersion:'1.0' as const,taskId:`offline-${item.id}-${current.id}`, ...current.task};
    const eligibility=getEligibleRoutes(task,registry,health,{allowPaid:true,dryRun:false,remainingBudgetUsd:5,allowedDomains:['example.com'],credentials:{openai:true,fal:true}});
    const eligibleHarnessIds=[...new Set(eligibility.eligible.map(route=>route.harness.id))];
    for(const path of ['direct','router'] as const){
      const expected=current.expected[path];if(!expected)continue;
      const passed=expected.status==='rejected'?eligibleHarnessIds.length===0:expected.selectedHarnessId?eligibleHarnessIds.includes(expected.selectedHarnessId):false;
      rows.push({caseId:item.id,stepId:current.id,path,passed,expectedHarnessId:expected.selectedHarnessId??null,eligibleHarnessIds,...(!passed?{failure:expected.status==='rejected'?'Expected no eligible route':`Expected harness ${expected.selectedHarnessId??'(unspecified)'} is not eligible`}:{})});
    }
  }
  return {mode:'offline-eligibility-only',providerCalls:0,decisionsCalls:0,cases:set.cases.length,steps:rows.length,passed:rows.filter(row=>row.passed).length,failed:rows.filter(row=>!row.passed).length,results:rows};
}

export function scoreStep(options:{
  step:EvaluationStep;
  path:EvaluationPath;
  result:HarnessResult;
  artifactMetadata?:Record<string,ArtifactVerification>;
}):CheckResult[] {
  const {step,path,result}=options;
  const expectation=step.expected[path];
  if(!expectation)throw new Error(`Step ${step.id} is not configured for ${path} evaluation`);
  const results:CheckResult[]=[{id:`${step.id}:status`,type:'result_status',status:result.status===expectation.status?'passed':'failed',evidence:result.status}];
  if(expectation.selectedHarnessId!==undefined)results.push({id:`${step.id}:selected-harness`,type:'selected_harness',status:result.selectedHarnessId===expectation.selectedHarnessId?'passed':'failed',evidence:result.selectedHarnessId??'none'});
  const checks=step.checks[path]??[];
  for(let i=0;i<checks.length;i++){
    const item=checks[i]!;const id=`${step.id}:check-${i+1}`;
    if(item.type==='no_selected_route'){
      results.push({id,type:item.type,status:result.selectedRouteId===null?'passed':'failed',evidence:result.selectedRouteId??'no route selected'});continue;
    }
    if(item.type==='verified_artifact'){
      const artifact=result.artifacts.find(candidate=>candidate.type===item.artifactType);
      const metadata=artifact?.path?options.artifactMetadata?.[artifact.path]:undefined;
      const passed=!!artifact?.verified&&!!artifact.path&&!!metadata?.mimeType&&!!metadata.sha256;
      const evidence=passed?`${artifact!.path}; ${metadata!.mimeType}; ${metadata!.sha256}`:metadata?.verificationError?`Independent verification failed: ${metadata.verificationError}`:`${item.artifactType} artifact missing or failed independent verification`;
      results.push({id,type:item.type,status:passed?'passed':'failed',evidence});continue;
    }
    if(item.type==='browser_observation'){
      const observation=result.structuredOutput?.websiteObservations as Record<string,unknown>|undefined;
      const style=observation?.visualStyle as Record<string,unknown>|undefined;
      const passed=typeof observation?.sourceUrl==='string'&&typeof observation.pageTitle==='string'&&observation.pageTitle.trim().length>0&&!!style&&Object.keys(style).length>0;
      results.push({id,type:item.type,status:passed?'passed':'failed',...(passed?{evidence:'websiteObservations.sourceUrl,pageTitle,visualStyle'}:{evidence:'Required structured website observations are missing'})});continue;
    }
    if(item.type==='image_aspect_ratio'){
      const artifact=result.artifacts.find(candidate=>candidate.type==='image');
      const metadata=artifact?.path?options.artifactMetadata?.[artifact.path]:undefined;
      const ratio=metadata?.width&&metadata.height&&metadata.height>0?metadata.width/metadata.height:undefined;
      const passed=ratio!==undefined&&Math.abs(ratio-item.ratio)<=item.tolerance;
      results.push({id,type:item.type,status:passed?'passed':'failed',...(ratio!==undefined?{evidence:`measured=${ratio.toFixed(4)}, expected=${item.ratio}`}:{evidence:'Image dimensions unavailable'})});continue;
    }
    if(item.type==='provider_request_id'){
      const requestId=result.structuredOutput?.providerRequestId??result.artifacts.find(artifact=>artifact.type==='image')?.providerRequestId;
      const passed=typeof requestId==='string'&&requestId.trim().length>0;
      results.push({id,type:item.type,status:passed?'passed':'failed',...(passed?{evidence:`providerRequestId=${requestId}`}:{evidence:'Provider request ID missing'})});continue;
    }
    const passed=typeof result.structuredOutput?.parentRunId==='string'&&typeof result.structuredOutput.observationFingerprint==='string'&&result.structuredOutput.observationFingerprint.length>0;
    results.push({id,type:item.type,status:passed?'passed':'failed',...(passed?{evidence:'parentRunId and observationFingerprint'}:{evidence:'Planner did not report consumption of prior observations'})});
  }
  return results;
}

export function summarizeEvaluation(results:Array<{caseId:string;path:EvaluationPath;verifiedSuccess:boolean;checks:CheckResult[];criteria?:Array<{status:'passed'|'failed'|'unverified'}>;cost:HarnessResult['cost']}>) {
  const paths:Record<EvaluationPath,{cases:number;verifiedSuccesses:number;failed:number;unverified:number;passedChecks:number;failedChecks:number;unverifiedChecks:number;passedCriteria:number;failedCriteria:number;unverifiedCriteria:number;knownOrEstimatedCostUsd:number;unknownCostCases:number}>={
    direct:{cases:0,verifiedSuccesses:0,failed:0,unverified:0,passedChecks:0,failedChecks:0,unverifiedChecks:0,passedCriteria:0,failedCriteria:0,unverifiedCriteria:0,knownOrEstimatedCostUsd:0,unknownCostCases:0},
    router:{cases:0,verifiedSuccesses:0,failed:0,unverified:0,passedChecks:0,failedChecks:0,unverifiedChecks:0,passedCriteria:0,failedCriteria:0,unverifiedCriteria:0,knownOrEstimatedCostUsd:0,unknownCostCases:0},
  };
  for(const row of results){const summary=paths[row.path];summary.cases++;if(row.verifiedSuccess)summary.verifiedSuccesses++;
    else if(row.checks.some(check=>check.status==='failed'))summary.failed++;else summary.unverified++;
    for(const check of row.checks){if(check.status==='passed')summary.passedChecks++;else if(check.status==='failed')summary.failedChecks++;else summary.unverifiedChecks++;}
    for(const criterion of row.criteria??[]){if(criterion.status==='passed')summary.passedCriteria++;else if(criterion.status==='failed')summary.failedCriteria++;else summary.unverifiedCriteria++;}
    if(row.cost.usd!==undefined&&(row.cost.status==='known'||row.cost.status==='estimated'||row.cost.status==='unknown'))summary.knownOrEstimatedCostUsd+=row.cost.usd;
    if(row.cost.status==='unknown')summary.unknownCostCases++;
  }
  return paths;
}
