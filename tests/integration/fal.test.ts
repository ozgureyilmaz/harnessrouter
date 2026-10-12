import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {loadConfig} from '../../src/config.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {RunTrace} from '../../src/observability/trace.js';
import {verifyImage} from '../../src/observability/artifacts.js';
import type {HarnessTask,Route} from '../../src/domain/types.js';
import {CreativeHarness} from '../../src/harnesses/fal-creative.js';
const config=loadConfig();
const missing=[!config.falKey?'FAL_KEY':undefined,process.env.FAL_LIVE_TESTS!=='true'?'FAL_LIVE_TESTS=true':undefined,!config.allowPaid?'ROUTER_ALLOW_PAID_RUNS=true':undefined,config.dryRun?'ROUTER_DRY_RUN=false':undefined,config.sessionUsd<=0?'authorized session budget':undefined].filter(Boolean);
test('LIVE fal integration (explicit opt-in, real provider, durable shared budget and evidence)',{skip:missing.length?`Live fal test skipped: ${missing.join(', ')}`:false},async()=>{
  const runId=randomUUID();const trace=new RunTrace(config.artifactsDir,runId);const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);const start=performance.now();
  const route:Route={id:'fal-creative:image-fast',description:'Verified schnell profile',generation_model_id:'fal-ai/flux/schnell',modalities:['image'],eligible_requirements:['text_to_image','image'],price_usd:.003,price_status:'estimated'};
  const task:HarnessTask={schemaVersion:'1.0',taskId:'integration-'+runId,prompt:'A single blue geometric flower on a plain cream background, no text.',requirements:['text_to_image','image'],acceptanceCriteria:['Decoded real image'],desiredOutput:'image',maxCostUsd:.01,allowPaidExecution:true,timeoutMs:120000};
  try{
    const result=await new CreativeHarness({apiKey:config.falKey,allowPaid:config.allowPaid,dryRun:config.dryRun,timeoutMs:120000}).execute(task,{runId,routeId:route.id,route,budgetUsd:.01,signal:AbortSignal.timeout(120000),artifactsDir:trace.directory,trace,budget:ledger.forRun(runId,.01)});
    await trace.save('harness-smoke.json',{mode:'LIVE_INTEGRATION_TEST',runId,routeId:route.id,elapsedMs:performance.now()-start,result});
    assert.equal(result.status,'completed',result.error?.message??'Live fal execution failed');assert.equal(result.selectedModelId,'fal-ai/flux/schnell');assert.ok(result.artifacts[0]?.providerRequestId);assert.ok(result.artifacts[0]?.path);
    await verifyImage(result.artifacts[0].path!,{expectedRatio:1});
  }finally{await ledger.close();}
});
