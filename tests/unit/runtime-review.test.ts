import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {loadConfig} from '../../src/config.js';
import {HarnessRouter} from '../../src/runner.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {ProcessWorkerAdapter} from '../../src/workers/adapter.js';
import {acquireWorkerLease} from '../../src/workers/lease.js';
import {workerManifests} from '../../src/workers/registry.js';
import {prepareWorkspace, collectPatch} from '../../src/workspace/snapshot.js';
import type {HarnessAdapter, HarnessTask, ExecutionContext} from '../../src/domain/types.js';
import type {WorkerProfile, WorkerProtocol} from '../../src/workers/types.js';
import type {DecisionsClient} from '../../src/routing/decisions.js';

const exec = promisify(execFile);
const profile:WorkerProfile={id:'review-worker',adapter:'codex',model:'fixture',enabled:true,allowExecution:true,allowUnknownCost:true};
async function fixture(t:{after(fn:()=>Promise<void>|void):void}) {
  const base=await realpath(await mkdtemp(join(tmpdir(),'hr-runtime-review-')));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const source=join(base,'source'); const state=join(base,'state');
  await mkdir(source);await mkdir(state);
  const env={PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'};
  await exec('git',['init','--quiet','--template='],{cwd:source,env});
  await writeFile(join(source,'README.md'),'fixture\n');
  await exec('git',['add','.'],{cwd:source,env});
  await exec('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','fixture'],{cwd:source,env});
  const config={...loadConfig({cwd:base,env:{XDG_CONFIG_HOME:join(base,'config')}}),selector:'local' as const,dryRun:false,allowExecution:true,workerProfiles:[profile],workspaceRoots:[source],artifactsDir:state};
  const ledger=await BudgetLedger.open(state,1);t.after(()=>ledger.close());
  const task:HarnessTask={schemaVersion:'1.1',taskId:'fixture-review',prompt:'Read README.md',requirements:['review'],acceptanceCriteria:[],desiredOutput:'text',preferredRouteId:`${profile.id}:configured`,allowUnknownCost:true,workspace:{root:source,mode:'read-only'},timeoutMs:5000};
  return {base,source,state,config,ledger,task};
}
const protocol:WorkerProtocol={kind:'codex',requiredHelpFlags:[],async probe(){return {available:true,modelId:'fixture'};},async invocation(){return {command:process.execPath,args:['-e',`console.log(JSON.stringify({type:'done'}))`]};},parse(){return {text:'Read the fixture.',cost:{status:'unknown'}};}};

test('offline: pinned route skips unrelated hanging probes and reuses fresh local health',async t=>{
  const {config,ledger,task,source,state}=await fixture(t);
  const other={...profile,id:'unrelated-worker'};config.workerProfiles.push(other);
  let selectedProbes=0;let unrelatedProbes=0;
  const selected=new ProcessWorkerAdapter(profile,{...protocol,async probe(){selectedProbes++;return {available:true,modelId:'fixture'};}},{roots:[source]},state,true);
  const unrelated:HarnessAdapter={id:other.id,async health(){unrelatedProbes++;return new Promise(()=>{});},async execute(){throw new Error('Unrelated worker must not execute');}};
  const router=new HarnessRouter(config,[selected,unrelated],ledger);
  const result=await router.routeTask(task);
  assert.equal(result.status,'completed',JSON.stringify(result.error));
  assert.equal(unrelatedProbes,0);assert.equal(selectedProbes,1);
});

test('offline: unauthorized roots and unsafe includes never reach Decisions or execution',async t=>{
  const {config,ledger,task,source,state,base}=await fixture(t);
  const second={...profile,id:'second-worker'};config.workerProfiles.push(second);
  let selectionCalls=0;let executions=0;
  const deniedProtocol={...protocol,async invocation(){executions++;throw new Error('No execution is authorized');}};
  const adapters=config.workerProfiles.map(p=>new ProcessWorkerAdapter(p,deniedProtocol,{roots:[source]},state,true));
  const decisions={async choose(){selectionCalls++;throw new Error('Selection should not be called');}} as unknown as DecisionsClient;
  const router=new HarnessRouter({...config,selector:'decisions',allowPaid:true},adapters,ledger,decisions);
  const outside=join(base,'outside');await mkdir(outside);
  for(const [index,workspace] of [{root:outside,mode:'read-only' as const},{root:source,mode:'read-only' as const,includeUntracked:['../escape']}].entries()){
    const result=await router.routeTask({...task,taskId:`denied-${index}`,preferredRouteId:undefined,workspace});
    assert.equal(result.status,'rejected',JSON.stringify(result));
  }
  assert.equal(selectionCalls,0);assert.equal(executions,0);
});

test('offline: Decisions selection always rechecks the chosen runtime liveness',async t=>{
  const {config,ledger,task,source,state}=await fixture(t);
  const second={...profile,id:'second-worker'};config.workerProfiles.push(second);
  let selectedProbes=0;let executions=0;let choices=0;
  const selectedProtocol={...protocol,async probe(){selectedProbes++;return {available:selectedProbes===1,modelId:'fixture'};},async invocation(){executions++;throw new Error('Stale worker must not execute');}};
  const adapters=[new ProcessWorkerAdapter(profile,selectedProtocol,{roots:[source]},state,true),new ProcessWorkerAdapter(second,protocol,{roots:[source]},state,true)];
  const decisions={async choose(){choices++;return {routeId:`${profile.id}:configured`,latencyMs:1,model:'gpt-6-luna',cost:{status:'not_applicable',usd:0}};}} as unknown as DecisionsClient;
  const router=new HarnessRouter({...config,selector:'decisions',allowPaid:true},adapters,ledger,decisions);
  const result=await router.routeTask({...task,preferredRouteId:undefined});
  assert.equal(result.error?.code,'adapter_unavailable');assert.equal(choices,1);assert.equal(selectedProbes,2);assert.equal(executions,0);
});

test('offline: hanging relevant health is bounded by the task abort signal',async t=>{
  const {config,ledger,task}=await fixture(t);
  let aborted=false;
  const hanging:HarnessAdapter={id:profile.id,async health(options){options?.signal?.addEventListener('abort',()=>{aborted=true;},{once:true});return new Promise(()=>{});},async execute(){throw new Error('Must not execute');}};
  const router=new HarnessRouter(config,[hanging],ledger);
  const controller=new AbortController();const resultPromise=router.routeTask(task,controller.signal);
  const timer=setTimeout(()=>controller.abort(),40);t.after(()=>clearTimeout(timer));
  const result=await resultPromise;
  assert.equal(result.status,'cancelled');assert.equal(aborted,true);
});

async function blockedGit(t:{after(fn:()=>Promise<void>|void):void},base:string,command:string){
  const actual=(await exec('which',['git'])).stdout.trim();
  const bin=join(base,'fake-bin');await mkdir(bin);
  const marker=join(base,'blocked-git.json');
  const script=`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes(${JSON.stringify(command)})){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{},1000);}else{const r=require('node:child_process').spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});process.exit(r.status??1);}\n`;
  await writeFile(join(bin,'git'),script);await chmod(join(bin,'git'),0o700);
  const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;t.after(()=>{process.env.PATH=previous;});
  return async()=>{
    const until=Date.now()+3000;
    while(Date.now()<until){try{return JSON.parse(await readFile(marker,'utf8')) as {pid:number;cwd:string};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,10));}}
    throw new Error('Controlled git command did not start');
  };
}

test('offline: abort kills snapshot Git subprocess and releases the worker lease',async t=>{
  const {base,state,source,ledger,task}=await fixture(t);const started=await blockedGit(t,base,'init');
  const controller=new AbortController();
  const adapter=new ProcessWorkerAdapter(profile,protocol,{roots:[source]},state,true);
  const context:ExecutionContext={runId:'abort-snapshot',routeId:`${profile.id}:configured`,route:workerManifests([profile])[0]!.routes[0]!,budgetUsd:0,budget:ledger.forRun('abort-snapshot',0),signal:controller.signal,artifactsDir:join(state,'abort-snapshot'),trace:{async event(){}}};
  const pending=adapter.execute(task,context);
  const rejected=assert.rejects(pending,/abort|cancel/i);
  const child=await started();controller.abort();await rejected;
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  const release=await acquireWorkerLease(state,profile.id,'after-abort');await release();
});

test('offline: abort during patch applicability preserves cancellation and stops Git',async t=>{
  const {base,state,source}=await fixture(t);const run=join(state,'patch-abort');
  const snapshot=await prepareWorkspace({root:source,mode:'patch'},run,{roots:[source]});
  await writeFile(join(snapshot.root,'README.md'),'changed\n');
  const started=await blockedGit(t,base,'apply');const controller=new AbortController();
  const pending=collectPatch(snapshot,run,controller.signal);const rejected=assert.rejects(pending,/abort|cancel/i);
  const child=await started();controller.abort();await rejected;
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  await assert.rejects(readFile(join(run,'workspace.patch')),{code:'ENOENT'});
});
