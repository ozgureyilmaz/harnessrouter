import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRouter} from '../src/create-router.js';
import {getEligibleRoutes} from '../src/registry/eligibility.js';
import {DecisionsClient} from '../src/routing/decisions.js';
import {RunTrace} from '../src/observability/trace.js';
import type {HarnessTask} from '../src/domain/types.js';
const router=await createRouter();const config=router.config;
try{
  const fixture=JSON.parse(await readFile(join(config.root,'fixtures/evaluation-tasks.json'),'utf8'));
  const list=await router.listHarnesses();const client=new DecisionsClient({apiKey:config.apiKey,allowPaid:config.allowPaid,dryRun:config.dryRun,timeoutMs:config.decisionTimeoutMs});
  const results:Record<string,unknown>[]=[];const confusion:Record<string,Record<string,number>>={};
  for(const f of fixture.tasks){
    const runId=randomUUID();const trace=new RunTrace(config.artifactsDir,runId);
    const browser=f.requirements.includes('browser');const image=f.requirements.includes('image');
    const task:HarnessTask={schemaVersion:'1.0',taskId:'eval-'+f.id+'-'+runId,prompt:f.task,requirements:f.requirements,acceptanceCriteria:[],...(f.requiredCapabilities?{requiredCapabilities:f.requiredCapabilities}:{}),maxCostUsd:.25,allowPaidExecution:true,
      ...(browser?{allowedDomains:['example.com'],context:{url:'https://example.com'},desiredOutput:f.requirements.includes('screenshot')?'screenshot':'text'}:image?{desiredOutput:'image',context:{creativeOptions:{quality:'balanced'}}}:{})};
    const eligible=getEligibleRoutes(task,list.registry,list.health,{allowPaid:config.allowPaid,dryRun:config.dryRun,remainingBudgetUsd:Math.min(.25,router.ledger.remainingUsd),allowedDomains:config.allowedDomains,credentials:list.credentials});
    let family='none';let decision:unknown;let method='deterministic_policy';let failure:unknown;
    if(eligible.eligible.length===1&&eligible.eligible[0].harness.id==='native')family='native';
    else if(eligible.eligible.length===1){family=eligible.eligible[0]!.harness.id;method='DETERMINISTIC_SINGLE_ROUTE';}
    else if(eligible.eligible.length>=2){
      method='LIVE_DECISIONS_CLASSIFICATION';
      try{const selected=await client.choose(task,eligible.eligible.map(c=>({value:c.route.id,description:c.route.description})),AbortSignal.timeout(15000),trace,router.ledger.forRun(runId,.25));family=selected.routeId.split(':')[0];decision=selected;}
      catch(e){family='error';failure={code:(e as {code?:string}).code,message:e instanceof Error?e.message:'unknown'};}
    }
    const row={fixtureId:f.id,runId,expectedFamily:f.expectedRouteFamily,actualFamily:family,method,passed:family===f.expectedRouteFamily,decision,failure,executionPerformed:false, ...(f.id==='B-04'?{limit:'Read-only Pi tools cannot trigger form feedback; this label experiment does not prove form-task completion.'}:{})};
    await trace.save('evaluation.json',row);results.push(row);
    confusion[f.expectedRouteFamily]??={};confusion[f.expectedRouteFamily][family]=(confusion[f.expectedRouteFamily][family]??0)+1;
  }
  const semantic=results.filter(r=>r.method==='LIVE_DECISIONS_CLASSIFICATION');
  const report={mode:'LIVE_ROUTING_LABEL_EVALUATION_NO_HARNESS_EXECUTION',cases:results.length,correct:results.filter(r=>r.passed).length,liveDecisionCases:semantic.length,liveDecisionCorrect:semantic.filter(r=>r.passed).length,liveDecisionLabelAccuracy:semantic.length?semantic.filter(r=>r.passed).length/semantic.length:null,confusionMatrix:confusion,results,limits:'One phrasing per fixture; public example URL supplied only for policy admission. Native/unsupported cases are deterministic. Classification is not task completion, model quality or efficiency.'};
  await writeFile(join(config.root,'demo/live-routing-evaluation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({cases:report.cases,correct:report.correct,liveDecisionCases:report.liveDecisionCases,liveDecisionCorrect:report.liveDecisionCorrect,accuracy:report.liveDecisionLabelAccuracy,confusionMatrix:confusion,output:'demo/live-routing-evaluation.json'},null,2));
  if(results.some(r=>!r.passed))process.exitCode=1;
}finally{await router.close();}
