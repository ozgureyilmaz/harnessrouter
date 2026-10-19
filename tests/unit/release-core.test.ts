import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {ProcessWorkerAdapter} from '../../src/workers/adapter.js';
import {workerManifests} from '../../src/workers/registry.js';
import {getEligibleRoutes} from '../../src/registry/eligibility.js';
import {selectLocal} from '../../src/routing/local.js';
import {runProcess,workerEnvironment} from '../../src/workers/process.js';
import {workspaceTool} from '../../src/workers/fs-mcp.js';
import {codexWorker} from '../../src/workers/codex.js';
import {claudeCodeWorker} from '../../src/workers/claude-code.js';
import type {WorkerProfile,WorkerProtocol} from '../../src/workers/types.js';
import type {HarnessTask} from '../../src/domain/types.js';
const profile:WorkerProfile={id:'fixture-worker',adapter:'codex',model:'fixture-model',enabled:true,allowExecution:true,allowUnknownCost:true};
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){const root=await realpath(await mkdtemp(join(tmpdir(),'hr-release-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('offline config: project files cannot grant execution; explicit trust and precedence are enforced',async t=>{
  const root=await fixture(t);await mkdir(join(root,'.harnessrouter'));
  await writeFile(join(root,'.harnessrouter/config.json'),JSON.stringify({allowExecution:true,dryRun:false,workerProfiles:[profile]}));
  await writeFile(join(root,'.env'),'ROUTER_ALLOW_PAID_RUNS=true\n');
  const env={XDG_CONFIG_HOME:join(root,'user')};
  const safe=loadConfig({cwd:root,env});assert.equal(safe.allowExecution,false);assert.equal(safe.allowPaid,false);assert.deepEqual(safe.workerProfiles,[]);
  const trusted=loadConfig({cwd:root,env:{...env,HARNESSROUTER_TRUST_PROJECT_CONFIG:'true',ROUTER_ALLOW_PAID_RUNS:'false'}});
  assert.equal(trusted.allowExecution,true);assert.equal(trusted.allowPaid,false);assert.equal(trusted.workerProfiles?.[0]?.id,profile.id);
  const explicit=loadConfig({cwd:root,configPath:join(root,'.harnessrouter/config.json'),env});assert.equal(explicit.allowExecution,true);
  await writeFile(join(root,'bad.json'),JSON.stringify({workerProfiles:[{...profile,unknown:1}]}));
  assert.throws(()=>loadConfig({cwd:root,configPath:join(root,'bad.json'),env}),/Invalid worker/);
});

test('offline routing: zero-dollar local worker admission needs explicit unknown-cost consent; no key',()=>{
  const task:HarnessTask={schemaVersion:'1.1',taskId:'fixture',prompt:'Review',requirements:['review'],acceptanceCriteria:[],workspace:{root:'/project',mode:'read-only'},allowUnknownCost:true};
  const registry={version:1 as const,harnesses:workerManifests([profile])};
  const policy={selector:'local' as const,allowPaid:false,dryRun:false,allowExecution:true,workerProfiles:[profile],allowedDomains:[],remainingBudgetUsd:0,credentials:{openai:false,fal:false}};
  const health={[profile.id]:{available:true}};
  const options=getEligibleRoutes(task,registry,health,policy);assert.equal(options.eligible.length,1);
  assert.equal(getEligibleRoutes({...task,allowUnknownCost:false},registry,health,policy).eligible.length,0);
  assert.equal(getEligibleRoutes(task,registry,health,{...policy,allowExecution:false}).eligible.length,0);
  assert.equal(getEligibleRoutes({...task,preferredRouteId:'injected:route'},registry,health,policy).eligible.length,0);
  const second={...options.eligible[0],route:{...options.eligible[0]!.route,id:'second:configured'}};
  assert.equal(selectLocal([...options.eligible,second]),undefined);
});

test('offline end-to-end: real subprocess returns verified patch, preserves dirty source, replays idempotently',async t=>{
  const root=await fixture(t);const source=join(root,'source');await mkdir(source);
  const git=(args:string[])=>runProcess('git',args,{cwd:source,env:workerEnvironment(),timeoutMs:5000});
  await git(['init','-q']);await writeFile(join(source,'input.txt'),'original\n');await git(['add','input.txt']);await git(['-c','user.name=fixture','-c','user.email=f@localhost','-c','commit.gpgsign=false','commit','-qm','fixture']);
  await writeFile(join(source,'input.txt'),'dirty user content\n');
  let invocations=0;
  const protocol:WorkerProtocol={kind:'codex',requiredHelpFlags:[],async probe(){return {available:true};},async invocation(_profile,{cwd}){invocations++;return {command:process.execPath,args:['-e',`const f=require('node:fs');f.writeFileSync('input.txt','worker change\\n');process.stdout.write(JSON.stringify({type:'done',text:'Changed'})+'\\n')`],env:{},stdin:''};},parse(records){assert.equal(records[0]?.type,'done');return {text:'Changed',cost:{status:'unknown'}};}};
  const config={...loadConfig({cwd:root,env:{XDG_CONFIG_HOME:join(root,'user')}}),selector:'local' as const,allowPaid:false,dryRun:false,allowExecution:true,workerProfiles:[profile],workspaceRoots:[source],artifactsDir:join(root,'runs')};
  const ledger=await BudgetLedger.open(config.artifactsDir,0);const adapter=new ProcessWorkerAdapter(profile,protocol,{roots:[source]},config.artifactsDir,true);
  const router=new HarnessRouter(config,[adapter],ledger);t.after(()=>router.close());
  const task:HarnessTask={schemaVersion:'1.1',taskId:'real-local-worker',prompt:'Change input.txt',requirements:['coding'],preferredRouteId:'fixture-worker:configured',desiredOutput:'patch',workspace:{root:source,mode:'patch'},allowUnknownCost:true,acceptanceCriteria:['Patch applies to captured baseline']};
  const result=await router.routeTask(task);assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.schemaVersion,'1.3');assert.equal(result.cost.status,'unknown');assert.equal(result.criterionResults[0]?.status,'passed');
  assert.equal(await readFile(join(source,'input.txt'),'utf8'),'dirty user content\n');
  assert.ok((await readFile(result.artifacts.find(a=>a.type==='patch')!.path!,'utf8')).includes('-dirty user content'));
  const replay=await router.routeTask(task);assert.equal(replay.runId,result.runId);assert.equal(invocations,1);
  const conflict=await router.routeTask({...task,prompt:'different'});assert.equal(conflict.error?.code,'idempotency_conflict');assert.equal(invocations,1);
});

test('offline workspace MCP: controlled tools reject secrets, traversal, symlinks and read-only writes',async t=>{
  const root=await fixture(t);await writeFile(join(root,'readme.txt'),'hello');
  assert.deepEqual(await workspaceTool(root,'read-only','read_file',{path:'readme.txt'}),{path:'readme.txt',content:'hello'});
  await assert.rejects(workspaceTool(root,'patch','read_file',{path:'../file'}),/relative/);
  await assert.rejects(workspaceTool(root,'patch','write_file',{path:'.env',content:'private'}),/relative/);
  await assert.rejects(workspaceTool(root,'read-only','write_file',{path:'file',content:'bad'}),/read-only/);
  await workspaceTool(root,'patch','write_file',{path:'src/file.txt',content:'new'});assert.equal(await readFile(join(root,'src/file.txt'),'utf8'),'new');
});

test('offline model binding: native runtime cannot silently change the allowed model',()=>{
  const events=[{type:'item.completed',item:{type:'agent_message',text:'done'}},{type:'turn.completed',turn:{model:'unexpected'}}];
  assert.throws(()=>codexWorker.parse(events,profile),/allowlist/);
  assert.equal(codexWorker.parse(events,{...profile,allowedModels:['unexpected']}).reportedModel,'unexpected');
  assert.throws(()=>claudeCodeWorker.parse([{type:'result',subtype:'success',is_error:false,result:'done',model:'unexpected'}],{...profile,adapter:'claude-code'}),/allowlist/);
});

test('offline adapter recovery: trace failure and late cancellation release the worker lease',async t=>{
  const root=await fixture(t);const source=join(root,'source');await mkdir(source);
  await runProcess('git',['init','-q'],{cwd:source,env:workerEnvironment()});
  const state=join(root,'state');await mkdir(state);
  const ledger=await BudgetLedger.open(state,0);t.after(()=>ledger.close());
  const protocol:WorkerProtocol={kind:'codex',requiredHelpFlags:[],async invocation(){return {command:process.execPath,args:['-e',`console.log(JSON.stringify({type:'done'}));setTimeout(()=>{},100)`]};},parse(){return {text:'Read-only answer',cost:{status:'unknown'}};}};
  const task:HarnessTask={schemaVersion:'1.1',taskId:'recovery',prompt:'Review',requirements:['review'],acceptanceCriteria:[],desiredOutput:'text',workspace:{root:source,mode:'read-only'},allowUnknownCost:true};
  const adapter=new ProcessWorkerAdapter(profile,protocol,{roots:[source]},state,true);
  const {acquireWorkerLease}=await import('../../src/workers/lease.js');
  for(const failure of ['trace','late-cancel']){
    const controller=new AbortController();const runId=failure;const runDirectory=join(state,runId);
    const context={runId,routeId:'fixture-worker:configured',route:workerManifests([profile])[0]!.routes[0]!,budgetUsd:0,budget:ledger.forRun(runId,0),signal:controller.signal,artifactsDir:runDirectory,trace:{async event(type:string){if(failure==='trace'&&type==='worker.raw_event')throw new Error('fixture disk error');if(failure==='late-cancel'&&type==='worker.verified')controller.abort();}}};
    await assert.rejects(adapter.execute(task,context));
    const release=await acquireWorkerLease(state,profile.id,'after-'+failure);await release();
  }
});
