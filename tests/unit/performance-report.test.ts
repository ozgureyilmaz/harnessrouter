import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPerformanceReport,formatPerformanceReport} from '../../src/observability/performance.js';
import {runCli} from '../../src/cli.js';
import type {HarnessResult,UsageRecord} from '../../src/domain/types.js';
const usage=(input=100,output=20):UsageRecord=>({schemaVersion:'1.0',provider:'fixture',model:'model',source:'fixture.canonical_v1',measurement:'provider_reported',completeness:'complete',tokens:{inputTokens:input,outputTokens:output,totalTokens:input+output,cachedInputTokens:40,reasoningOutputTokens:5}});
async function root(t:{after:(fn:()=>Promise<void>)=>void}){const path=await mkdtemp(join(tmpdir(),'hr-performance-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function save(root:string,patch:Partial<HarnessResult>={},requirements=['review']){
  const id=randomUUID();const directory=join(root,id);await mkdir(directory);
  const result:HarnessResult={schemaVersion:'1.3',runId:id,taskId:id,status:'completed',selectedRouteId:'worker:configured',selectedHarnessId:'worker',selectedModelId:'model',artifacts:[],criterionResults:[{criterion:'Readable text answer',status:'passed',verifier:'artifact'}],timing:{totalMs:120,executionMs:100},cost:{status:'unknown'},usage:[usage()],costComponents:[{provider:'fixture',source:'native usage',status:'unknown'}],structuredOutput:{provenance:{requestedModel:'model',reportedModel:null}},...patch};
  await writeFile(join(directory,'result.json'),JSON.stringify(result));await writeFile(join(directory,'task.json'),JSON.stringify({prompt:'PRIVATE FIXTURE PROMPT',requirements,context:{private:'not-for-report'}}));return directory;
}

test('local stats count cached/reasoning subsets once and expose failures, coverage and unpriced cost',async t=>{
  const path=await root(t);
  await save(path);await save(path,{timing:{totalMs:180,executionMs:140},usage:[usage(200,40)],cost:{status:'estimated',usd:.2},costComponents:[{provider:'fixture',source:'estimate',status:'rate_estimate',usd:.2}]});
  await save(path,{status:'failed',timing:{totalMs:900},usage:[],criterionResults:[],error:{code:'fixture',message:'failed'}});
  const report=await readPerformanceReport(path,{sortBy:'tokens'});const row=report.routes[0]!;
  assert.equal(row.attempts,3);assert.equal(row.completed,2);assert.equal(row.failed,1);
  assert.equal(row.timing.medianTotalMs,150);assert.equal(row.timing.p95TotalMs,180);assert.equal(row.timing.medianOverheadMs,30);
  assert.equal(row.usage.medianInputTokens,150);assert.equal(row.usage.medianOutputTokens,30);assert.equal(row.usage.medianTotalTokens,180);assert.equal(row.usage.medianCachedInputTokens,40);
  assert.equal(row.usage.completeRuns,2);assert.equal(row.usage.unavailableRuns,1);assert.equal(row.cost.estimatedSubtotalUsd,.2);assert.equal(row.cost.unpricedRuns,2);
  assert.equal(report.scope,'router_and_worker_only');assert.equal(report.comparison,'observational_not_controlled');
  assert.ok(!JSON.stringify(report).includes('PRIVATE FIXTURE'));assert.ok(!JSON.stringify(report).includes('not-for-report'));
});

test('legacy, partial, contradictory and missing usage never produce a false token winner or zero',async t=>{
  const path=await root(t);
  await save(path,{selectedRouteId:'legacy:configured',usage:[{...usage(),source:'pi.message_end'}]});
  await save(path,{selectedRouteId:'partial:configured',usage:[{...usage(),completeness:'partial'}]});
  await save(path,{selectedRouteId:'wrong:configured',usage:[{...usage(),tokens:{...usage().tokens,totalTokens:999}}]});
  await save(path,{selectedRouteId:'missing:configured',usage:[]});
  await save(path,{selectedRouteId:'wrong-cache:configured',usage:[{...usage(),tokens:{...usage().tokens,cachedInputTokens:90,cacheWriteInputTokens:90}}]});
  await save(path,{selectedRouteId:'known:configured',usage:[usage(1000,200)]});
  const report=await readPerformanceReport(path,{sortBy:'tokens'});
  assert.equal(report.routes[0]?.routeId,'known:configured');
  for(const row of report.routes.slice(1))assert.equal(row.usage.medianTotalTokens,null);
  assert.equal(report.routes.find(r=>r.routeId==='legacy:configured')?.usage.legacyRuns,1);
  assert.match(formatPerformanceReport(report),/unavailable/);
});

test('stats filter task types, keep model groups separate, bound scanning and ignore non-run directories',async t=>{
  const path=await root(t);await mkdir(join(path,'releases'));
  await save(path,{selectedModelId:'a'},['coding']);await save(path,{selectedModelId:'b'},['coding']);await save(path,{},['browser','screenshot']);
  const filtered=await readPerformanceReport(path,{taskType:'coding'});assert.equal(filtered.routes.length,2);assert.ok(filtered.routes.every(row=>row.taskType==='coding'));
  const limited=await readPerformanceReport(path,{limit:1});assert.equal(limited.scan.examined,1);assert.equal(limited.scan.limited,true);
  const absent=await readPerformanceReport(join(path,'missing'));assert.equal(absent.routes.length,0);assert.match(formatPerformanceReport(absent),/No matching saved/);
  await assert.rejects(readPerformanceReport(path,{limit:0}),/limit/);
});

test('stats skip malformed and symlink result files rather than reading unrelated data',async t=>{
  const path=await root(t);const malformed=join(path,randomUUID());await mkdir(malformed);await writeFile(join(malformed,'result.json'),'{bad');
  const linked=join(path,randomUUID());await mkdir(linked);const outside=join(path,'external.json');await writeFile(outside,JSON.stringify({private:'not-a-result'}));await symlink(outside,join(linked,'result.json'));
  const report=await readPerformanceReport(path);assert.equal(report.scan.invalid,2);assert.equal(report.routes.length,0);
});

test('CLI stats is read-only and does not probe enabled executables or make provider calls',async t=>{
  const path=await root(t);const state=join(path,'runs');await mkdir(state);await save(state);
  const marker=join(path,'should-not-exist');const executable=join(path,'runtime');await writeFile(executable,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  const config=join(path,'config.json');await writeFile(config,JSON.stringify({artifactsDir:state,allowExecution:true,workerProfiles:[{id:'worker',adapter:'codex',model:'model',enabled:true,allowExecution:true,executable}]}));
  let output='';let errors='';const status=await runCli(['stats','--config',config,'--sort','tokens','--task-type','review','--json'],{cwd:path,env:{XDG_CONFIG_HOME:join(path,'user')},stdout:text=>output+=text,stderr:text=>errors+=text});
  assert.equal(status,0,errors);assert.equal(JSON.parse(output).routes.length,1);await assert.rejects(readFile(marker),{code:'ENOENT'});
  assert.equal(await runCli(['stats','--limit','-1'],{stdout:()=>{},stderr:()=>{}}),1);
});

test('legacy cost fallback and missing task identity remain explicit in the report',async t=>{
  const path=await root(t);
  const directory=await save(path,{schemaVersion:'1.1',cost:{status:'known',usd:.25},costComponents:undefined});
  await rm(join(directory,'task.json'));
  const report=await readPerformanceReport(path);const row=report.routes[0]!;
  assert.equal(row.cost.reportedSubtotalUsd,.25);assert.equal(row.cost.unpricedRuns,0);
  assert.equal(row.distinctTaskSpecs,null);assert.equal(row.unknownTaskSpecs,1);assert.equal(report.scan.missingTaskMetadata,1);
  assert.match(formatPerformanceReport(report),/model \[configured\]/);
  await save(path,{schemaVersion:'1.1',selectedRouteId:'missing-cost:configured',cost:{status:'known'},costComponents:undefined});
  const missing=(await readPerformanceReport(path)).routes.find(r=>r.routeId==='missing-cost:configured')!;
  assert.equal(missing.cost.unpricedRuns,1);
});
