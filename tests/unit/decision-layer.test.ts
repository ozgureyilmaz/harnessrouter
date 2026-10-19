import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,type RouterConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {createDecisionSelector} from '../../src/routing/decision-factory.js';
import {SystemOneDecisionsClient} from '../../src/routing/systemone.js';
import type {DecisionSelector} from '../../src/routing/decision-provider.js';
import type {HarnessAdapter,HarnessTask} from '../../src/domain/types.js';
import type {WorkerProfile} from '../../src/workers/types.js';

const profiles:WorkerProfile[]=['first','second'].map(id=>({id:`${id}-worker`,adapter:'codex',model:'fixture-model',enabled:true,allowExecution:true,allowUnknownCost:true}));
type TestContext={after(fn:()=>void|Promise<void>):void};
async function setup(t:TestContext,provider:'openai'|'jev'|'ollaya'='ollaya'){
  const root=await mkdtemp(join(tmpdir(),'hr-decision-layer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadConfig({cwd:root,env:{XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state'),ROUTER_DECISION_PROVIDER:provider,MAX_COST_USD_PER_TASK:provider==='ollaya'?'0':'.25'}});
  Object.assign(config,{dryRun:false,allowPaid:provider!=='ollaya',allowExecution:true,workerProfiles:profiles,workspaceRoots:[root],artifactsDir:join(root,'runs')});
  const ledger=await BudgetLedger.open(config.artifactsDir,provider==='ollaya'?0:1);t.after(()=>ledger.close());
  const executed:string[]=[];
  const adapters:HarnessAdapter[]=profiles.map(profile=>({id:profile.id,async health(){return {available:true,modelId:profile.model};},async execute(_task,context){
    executed.push(profile.id);const path=join(context.artifactsDir,'answer.txt');await writeFile(path,'Offline fixture answer');
    return {status:'completed',summary:'Offline fixture answer',artifacts:[{type:'text',path,verified:false}],cost:{status:'unknown',details:'Fixture worker has no provider invoice'}};
  }}));
  const task:HarnessTask={schemaVersion:'1.1',taskId:'fixture-task',prompt:'Review this project',requirements:['review'],desiredOutput:'text',workspace:{root,mode:'read-only'},allowUnknownCost:true,acceptanceCriteria:[]};
  return {root,config,ledger,adapters,executed,task};
}
function systemAnswer(choice:string,model='laya:typed-decisions'){return {model,answers:{execution_route:{type:'choice',choice}},usage:{input_tokens:120,output_tokens:0}};}
async function httpFixture(t:TestContext,reply:(body:any)=>unknown){
  let calls=0;let offered:string[]=[];
  const server=createServer(async(req,res)=>{
    calls++;assert.equal(req.url,'/v1/systemone');assert.equal(req.headers.authorization,undefined);
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());offered=Object.keys(body.questions.execution_route.criteria);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,get calls(){return calls;},get offered(){return offered;}};
}

test('offline factory selects OpenAI by default and each user-selected provider without a request',async t=>{
  const {config}=await setup(t,'openai');
  for(const [provider,model,requiresPaid] of [['openai','gpt-6-luna',true],['jev','jev-latest',true],['ollaya','laya:typed-decisions',false]] as const){
    const selector=createDecisionSelector({...config,decisionProvider:provider,decisionModel:model,decisionReserveUsd:requiresPaid?.02:0});
    assert.equal(selector.provider,provider);assert.equal(selector.requiresPaid,requiresPaid);assert.equal(selector.reservationUsd,requiresPaid?.02:0);
  }
});

test('offline HTTP fixture: Ollaya routes at zero provider budget and preserves provider-specific trace and usage',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t);
  const http=await httpFixture(t,()=>systemAnswer('second-worker:configured'));
  config.ollayaBaseUrl=http.url;const router=new HarnessRouter(config,adapters,ledger);
  const result=await router.routeTask(task);
  assert.equal(result.status,'completed',JSON.stringify(result.error));assert.deepEqual(executed,['second-worker']);assert.equal(http.calls,1);
  assert.deepEqual(http.offered.sort(),['first-worker:configured','second-worker:configured'].sort());
  assert.equal(ledger.committedUsd,0);assert.equal(result.usage?.[0]?.provider,'ollaya');assert.equal(result.usage?.[0]?.tokens.totalTokens,120);
  assert.equal(result.costComponents?.some(item=>item.provider==='ollaya'),false);
  const decision=(await router.getRun(result.runId)).decision as Record<string,unknown>;
  assert.equal(decision.schemaVersion,'1.1');assert.equal(decision.decisionProvider,'ollaya');assert.equal(decision.decisionModel,'laya:typed-decisions');
  assert.equal(decision.selectedRouteId,'second-worker:configured');
  const listing=await router.listHarnesses();assert.equal(listing.decisionLayer.provider,'ollaya');assert.equal(listing.decisionLayer.requiresPaid,false);
});

test('offline HTTP fixture: unoffered Ollaya route fails without execution, spending, retry or fallback',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t);const http=await httpFixture(t,()=>systemAnswer('injected:route'));
  config.ollayaBaseUrl=http.url;const router=new HarnessRouter(config,adapters,ledger);const result=await router.routeTask(task);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'invalid_decision');assert.deepEqual(executed,[]);assert.equal(http.calls,1);assert.equal(ledger.committedUsd,0);
  assert.equal(result.cost.status,'not_applicable');assert.equal(result.costComponents?.length,0);
  assert.equal((await router.getRun(result.runId)).decision && ((await router.getRun(result.runId)).decision as Record<string,unknown>).decisionStatus,'invalid_response');
});

test('mocked hosted Jev: reservation and usage remain attributed to Jev and unknown USD stays committed',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t,'jev');let calls=0;
  const selector=new SystemOneDecisionsClient({provider:'jev',apiKey:'fixture-private-key',allowPaid:true,dryRun:false,reservationUsd:.02,transport:async input=>{
    calls++;assert.equal(input.url,'https://api.typesafe.ai/v1/systemone');return {data:systemAnswer('first-worker:configured','jev-1.13.0'),requestId:'fixture-request'};
  }});
  const router=new HarnessRouter(config,adapters,ledger,selector);const result=await router.routeTask(task);
  assert.equal(result.status,'completed',JSON.stringify(result.error));assert.deepEqual(executed,['first-worker']);assert.equal(calls,1);assert.equal(ledger.committedUsd,.02);
  assert.equal(result.usage?.[0]?.provider,'jev');assert.equal(result.usage?.[0]?.model,'jev-1.13.0');assert.equal(result.costComponents?.[0]?.provider,'jev');assert.equal(result.costComponents?.[0]?.status,'unknown');
  assert.equal(result.cost.status,'unknown');assert.ok(!(await readFile(result.tracePath!,'utf8')).includes('fixture-private-key'));
});

test('offline router: explicit route skips paid selector but retains worker execution and unknown-cost authorization',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t,'openai');config.allowPaid=false;let calls=0;
  const selector:DecisionSelector={provider:'openai',requiresPaid:true,reservationUsd:.01,async choose(){calls++;throw new Error('Pinned route must not call selector');}};
  const router=new HarnessRouter(config,adapters,ledger,selector);
  const allowed=await router.routeTask({...task,preferredRouteId:'first-worker:configured',maxCostUsd:0});assert.equal(allowed.status,'completed',JSON.stringify(allowed.error));
  const denied=await router.routeTask({...task,taskId:'denied',preferredRouteId:'second-worker:configured',allowUnknownCost:false});assert.equal(denied.status,'rejected');
  assert.equal(calls,0);assert.deepEqual(executed,['first-worker']);assert.equal(ledger.committedUsd,0);
});

test('offline router: default OpenAI host defer requires neither a key nor fee budget',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t,'openai');config.allowPaid=false;config.apiKey=undefined;
  const router=new HarnessRouter(config,adapters,ledger);
  const result=await router.routeTask({...task,requirements:['host_owned_tasks'],workspace:undefined,allowUnknownCost:undefined,maxCostUsd:0});
  assert.equal(result.status,'defer_to_host',JSON.stringify(result.error));assert.deepEqual(executed,[]);assert.equal(ledger.committedUsd,0);
});

test('offline router: local selector and zero-cap hosted selector construct without reserving before host defer',async t=>{
  for(const selector of ['local','decisions'] as const){
    const {config,ledger,adapters,executed,task}=await setup(t,'openai');
    config.selector=selector;config.perTaskUsd=0;config.decisionReserveUsd=.01;
    assert.equal(createDecisionSelector(config).reservationUsd,.01);
    const router=new HarnessRouter(config,adapters,ledger);
    const result=await router.routeTask({...task,requirements:['host_owned_tasks'],workspace:undefined,allowUnknownCost:undefined,maxCostUsd:0});
    assert.equal(result.status,'defer_to_host',JSON.stringify(result.error));
    assert.deepEqual(executed,[]);assert.equal(ledger.committedUsd,0);
    const saved=await router.getRun(result.runId);
    assert.equal((saved.decision as Record<string,unknown>).decisionStatus,'not_required');
  }
});

test('offline router: missing hosted key fails explicitly without executing a worker or choosing another provider',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t,'jev');config.jevApiKey=undefined;
  const result=await new HarnessRouter(config,adapters,ledger).routeTask(task);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'credential_missing:jev');assert.deepEqual(executed,[]);assert.equal(ledger.committedUsd,0);
});

test('offline router: sole review worker needs no hosted key, fee authorization or fee budget',async t=>{
  for(const provider of ['openai','jev'] as const){
    const {config,ledger,adapters,executed,task}=await setup(t,provider);
    config.workerProfiles=[profiles[0]!];config.allowPaid=false;config.apiKey=undefined;config.jevApiKey=undefined;config.perTaskUsd=0;
    const router=new HarnessRouter(config,adapters,ledger);
    const result=await router.routeTask({...task,maxCostUsd:0});
    assert.equal(result.status,'completed',JSON.stringify(result.error));assert.deepEqual(executed,['first-worker']);assert.equal(ledger.committedUsd,0);
    assert.equal((await router.getRun(result.runId)).decision&&((await router.getRun(result.runId)).decision as Record<string,unknown>).decisionStatus,'not_required');
  }
});

test('offline router: selector admission waits for workspace preflight and still blocks an unauthorized multi-route choice',async t=>{
  const {config,ledger,adapters,executed,task}=await setup(t,'openai');config.allowPaid=false;config.apiKey=undefined;
  const router=new HarnessRouter(config,adapters,ledger);
  const blocked=await router.routeTask({...task,taskId:'multiple'});
  assert.equal(blocked.status,'permission_required');assert.deepEqual(executed,[]);assert.equal(ledger.committedUsd,0);
  adapters[1]!.preflight=async()=>{throw new Error('Offline fixture workspace constraint');};
  const single=await router.routeTask({...task,taskId:'after-preflight',maxCostUsd:0});
  assert.equal(single.status,'completed',JSON.stringify(single.error));assert.deepEqual(executed,['first-worker']);assert.equal(ledger.committedUsd,0);
});
