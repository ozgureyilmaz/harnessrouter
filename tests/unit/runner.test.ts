import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessRouter} from '../../src/runner.js';
import {loadConfig} from '../../src/config.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {DecisionsClient} from '../../src/routing/decisions.js';
import type {HarnessTask} from '../../src/domain/types.js';
import sharp from 'sharp';
const task:HarnessTask={schemaVersion:'1.0',taskId:'mock-native',prompt:'Refactor repository TypeScript',requirements:['coding'],acceptanceCriteria:[],maxCostUsd:.25};
const imageTask:HarnessTask={...task,taskId:'mock-image',prompt:'Create a simple test illustration',requirements:['text_to_image','image'],desiredOutput:'image',allowPaidExecution:true};
async function makeRouter(choice='fal-creative:image-fast',patch:Partial<ReturnType<typeof loadConfig>>={}){
  const root=await mkdtemp(join(tmpdir(),'hr-runner-'));const config={...loadConfig(),selector:'decisions' as const,allowPaid:true,dryRun:false,apiKey:undefined,falKey:'unit-test-only',...patch,artifactsDir:root};
  let calls=0;
  const decisions=new DecisionsClient({allowPaid:true,dryRun:false,client:{decisions:{create(){calls++;return{withResponse:async()=>({request_id:'mock-id',data:{model:'gpt-6-luna',answers:[{type:'choice',name:'execution_route',choice}],usage:{input_tokens:100,output_tokens:10,total_tokens:110}}})};}}}});
  const mockAdapter={id:'fal-creative',health:async()=>({available:true}),execute:async(_task:HarnessTask,ctx:{artifactsDir:string})=>{
    const path=join(ctx.artifactsDir,'mock-unit-image.png');await sharp({create:{width:64,height:64,channels:3,background:'#444'}}).png().toFile(path);
    return {status:'completed' as const,summary:'Offline mock artifact',artifacts:[{type:'image' as const,path,verified:false,providerRequestId:'fal-test-request'}],cost:{status:'estimated' as const,usd:.003,details:'Fixture published-rate estimate'}};
  }};
  const ledger=await BudgetLedger.open(root,5);const router=new HarnessRouter(config,[mockAdapter],ledger,decisions);
  return {router,root,get calls(){return calls;},async close(){await router.close();await rm(root,{recursive:true,force:true});}};
}
test('mocked runner: native control skips Decisions; image task ID replays without provider request',async()=>{
  const fixture=await makeRouter();try{
    const control=await fixture.router.routeTask(task);assert.equal(control.status,'defer_to_host');assert.equal(fixture.calls,0);
    const one=await fixture.router.routeTask({...imageTask,acceptanceCriteria:['Image decodes']});assert.equal(one.status,'completed');assert.equal(one.schemaVersion,'1.2');assert.deepEqual(one.criterionResults.map(item=>item.status),['passed']);assert.equal(fixture.calls,1);
    assert.equal(one.usage?.[0]?.provider,'openai');assert.equal(one.usage?.[0]?.tokens.totalTokens,110);
    assert.deepEqual(one.costComponents?.map(component=>component.status),['rate_estimate','rate_estimate']);
    const imageWithCriterion={...imageTask,acceptanceCriteria:['Image decodes']};
    const replay=await fixture.router.routeTask(imageWithCriterion);assert.equal(replay.runId,one.runId);assert.equal(fixture.calls,1);
    const conflict=await fixture.router.routeTask({...imageWithCriterion,prompt:'Different operation'});assert.equal(conflict.error?.code,'idempotency_conflict');assert.equal(fixture.calls,1);
    const decision=JSON.parse(await readFile(join(fixture.root,one.runId,'decision.json'),'utf8'));assert.equal(decision.selectedRouteId,'fal-creative:image-fast');
  }finally{await fixture.close();}
});
test('mocked runner: unoffered Decision is never executed and saved as invalid response',async()=>{
  const fixture=await makeRouter('unknown:execute');try{const result=await fixture.router.routeTask({...imageTask,taskId:'invalid'});assert.equal(result.status,'failed');assert.equal(result.selectedRouteId,null);assert.equal(result.error?.code,'invalid_decision');
    assert.equal(result.usage?.[0]?.tokens.totalTokens,110);assert.equal(result.costComponents?.[0]?.status,'rate_estimate');
    const decision=JSON.parse(await readFile(join(fixture.root,result.runId,'decision.json'),'utf8'));assert.equal(decision.decisionStatus,'invalid_response');
  }finally{await fixture.close();}
});
test('mocked runner: prohibited task and aborted host signal make no provider requests',async()=>{
  const fixture=await makeRouter();try{
    const result=await fixture.router.routeTask({...task,taskId:'private',requirements:['private_account_action']});assert.equal(result.status,'rejected');assert.equal(fixture.calls,0);
    const c=new AbortController();c.abort();const cancelled=await fixture.router.routeTask({...task,taskId:'cancelled'},c.signal);assert.equal(cancelled.status,'cancelled');assert.equal(fixture.calls,0);
  }finally{await fixture.close();}
});

test('mocked runner: unsupported required capability is rejected before Decisions',async()=>{
  const fixture=await makeRouter();try{
    const result=await fixture.router.routeTask({...imageTask,taskId:'unsupported-capability',requiredCapabilities:['browser.form_interaction']});
    assert.equal(result.status,'rejected');
    assert.equal(result.error?.code,'no_eligible_route');
    assert.equal(fixture.calls,0);
  }finally{await fixture.close();}
});

test('mocked runner: ROUTER_IMAGE_ROUTE pins one image profile and skips Decisions',async()=>{
  const fixture=await makeRouter('fal-creative:image-quality',{imageRoute:'fast'});try{
    const result=await fixture.router.routeTask({...imageTask,taskId:'pinned-fast'});
    assert.equal(result.status,'completed');
    assert.equal(result.selectedRouteId,'fal-creative:image-fast');
    assert.equal(fixture.calls,0);
    const decision=JSON.parse(await readFile(join(fixture.root,result.runId,'decision.json'),'utf8'));
    assert.equal(decision.decisionStatus,'not_required');
    assert.equal(decision.reason,'single_eligible_route');
  }finally{await fixture.close();}
});

test('mocked runner: a sole eligible specialist route executes without a Decisions choice request',async()=>{
  const fixture=await makeRouter();try{
    const taskWithOneProfile={...imageTask,taskId:'single-eligible-route',requiredCapabilities:['media.text_to_image'],context:{creativeOptions:{quality:'high'}}};
    const result=await fixture.router.routeTask(taskWithOneProfile);
    assert.equal(result.status,'completed');
    assert.equal(result.selectedRouteId,'fal-creative:image-quality');
    assert.equal(fixture.calls,0);
    const decision=JSON.parse(await readFile(join(fixture.root,result.runId,'decision.json'),'utf8'));
    assert.equal(decision.decisionStatus,'not_required');
    assert.equal(decision.reason,'single_eligible_route');
  }finally{await fixture.close();}
});

test('mocked runner: explicit route preflight receives the full budget when selection is skipped',async()=>{
  const fixture=await makeRouter();try{
    const budgets:number[]=[];
    fixture.router.adapters[0]!.preflight=async(_task,context)=>{budgets.push(context.budgetUsd);assert.ok(context.budgetUsd>=.003);};
    const result=await fixture.router.routeTask({...imageTask,taskId:'pinned-budget',preferredRouteId:'fal-creative:image-fast',maxCostUsd:.003});
    assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(fixture.calls,0);assert.deepEqual(budgets,[.003,.003]);
  }finally{await fixture.close();}
});

test('mocked runner: static image pin does not require a selection reserve',async()=>{
  const fixture=await makeRouter(undefined,{imageRoute:'fast'});try{
    fixture.router.adapters[0]!.preflight=async(_task,context)=>{assert.ok(context.budgetUsd>=.003);};
    const result=await fixture.router.routeTask({...imageTask,taskId:'static-pin-budget',maxCostUsd:.003});
    assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.selectedRouteId,'fal-creative:image-fast');assert.equal(fixture.calls,0);
  }finally{await fixture.close();}
});

test('mocked runner: cached v1 result is upgraded without pretending old criteria were verified',async()=>{
  const fixture=await makeRouter();try{
    const legacyTask={...imageTask,acceptanceCriteria:['Image decodes']};
    const first=await fixture.router.routeTask(legacyTask);
    const path=join(fixture.root,first.runId,'result.json');
    const saved=JSON.parse(await readFile(path,'utf8'));saved.schemaVersion='1.0';delete saved.criterionResults;
    await writeFile(path,JSON.stringify(saved));
    const replay=await fixture.router.routeTask(legacyTask);
    assert.equal(replay.schemaVersion,'1.1');
    assert.deepEqual(replay.criterionResults.map(item=>item.status),['unverified']);
    assert.equal(fixture.calls,1);
  }finally{await fixture.close();}
});
