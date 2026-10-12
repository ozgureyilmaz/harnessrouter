import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../../src/config.js';
import {RunTrace} from '../../src/observability/trace.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {verifyImage} from '../../src/observability/artifacts.js';
import {PiBrowserHarness} from '../../src/harnesses/pi-browser.js';
import type {HarnessTask,Route} from '../../src/domain/types.js';
const config=loadConfig();
const optedIn=process.env.PI_BROWSER_INTEGRATION==='1'&&config.allowPaid&&!config.dryRun;
test('LIVE Pi integration (explicit opt-in, real RPC agent, isolated Chrome and saved evidence)',{skip:optedIn?false:'Set PI_BROWSER_INTEGRATION=1 with authorized live configuration; no model or browser task was started.'},async(t)=>{
  const adapter=new PiBrowserHarness({allowedDomains:['example.com']});t.after(()=>adapter.close());
  const health=await adapter.health();if(!health.available){t.skip(`Pi unavailable: ${health.reason}`);return;}
  const runId=randomUUID();const trace=new RunTrace(config.artifactsDir,runId);const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);const start=performance.now();
  const task:HarnessTask={schemaVersion:'1.0',taskId:'integration-'+runId,prompt:'Inspect https://example.com and report its title and measured visual style. Capture a screenshot.',requirements:['browser','screenshot'],acceptanceCriteria:['Actual navigation','Decoded screenshot'],allowedDomains:['example.com'],context:{url:'https://example.com/'},desiredOutput:'screenshot',timeoutMs:120000};
  const route:Route={id:'pi-browser:configured',description:'Verified configured Pi model',agent_model_profile:'configured',modalities:['text','screenshot'],eligible_requirements:['browser','screenshot'],price_status:'not_applicable'};
  try{
    const result=await adapter.execute(task,{runId,routeId:route.id,route,budgetUsd:0,signal:AbortSignal.timeout(120000),artifactsDir:trace.directory,trace,budget:ledger.forRun(runId,0)});
    await trace.save('harness-smoke.json',{mode:'LIVE_INTEGRATION_TEST',runId,routeId:route.id,elapsedMs:performance.now()-start,result});
    assert.equal(result.status,'completed',result.error?.message??'Live Pi execution failed');assert.equal(result.selectedModelId,health.modelId);assert.ok(result.artifacts[0]?.path);await verifyImage(result.artifacts[0].path!);
    const observation=result.structuredOutput?.websiteObservations as {sourceUrl?:string;visualStyle?:unknown};assert.match(observation.sourceUrl??'',/^https:\/\/example\.com/);assert.ok(observation.visualStyle);
  }finally{await ledger.close();}
});
