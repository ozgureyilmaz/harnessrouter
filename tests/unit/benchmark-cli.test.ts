import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {BenchmarkRunRecord} from '../../src/domain/types.js';

const exec=promisify(execFile);
const root=resolve('.');
async function cli(args:string[]){return exec(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),join(root,'scripts/benchmark.ts'),...args],{cwd:root,timeout:15000,maxBuffer:100000});}
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'hr-cli-offline-'));
  const caseFile=join(dir,'case.json');await writeFile(caseFile,JSON.stringify({caseId:'offline-case',prompt:'Private example text must not enter metering events.'}));
  const fake=join(dir,'fake-codex.cjs');
  await writeFile(fake,`#!/usr/bin/env node
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.144.4\\n');process.exit(0);}
if(process.env.OPENAI_API_KEY||process.env.FAL_KEY||process.env.GH_TOKEN)process.exit(66);
const fs=require('node:fs');
const args=process.argv;fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'');
process.stdin.resume();process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'thread.started',thread_id:'offline-thread'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Offline fixture final response.'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:20,output_tokens:15,reasoning_output_tokens:8}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'harnessrouter',tool:'route_task',arguments:{private:'SHOULD_NOT_PERSIST'},result:{structured_content:{runId:'12345678-1234-4234-8234-123456789012',summary:'SHOULD_NOT_PERSIST',artifacts:[],usage:[],costComponents:[]}}}}));
});
`,{mode:0o700});
  const artifacts=join(dir,'artifacts');return {dir,caseFile,fake,artifacts};
}

test('offline fake CLI captures version, usage, private evidence, and snake-case MCP links',async()=>{
  const f=await fixture();
  try{
    await cli(['run','--artifacts-dir',f.artifacts,'--case',f.caseFile,'--arm','codex_harnessrouter','--model','gpt-6.1-sol','--codex',f.fake]);
    const files=await readdir(join(f.artifacts,'benchmark/runs'));
    const record=JSON.parse(await readFile(join(f.artifacts,'benchmark/runs',files[0]!), 'utf8')) as BenchmarkRunRecord;
    assert.equal(record.status,'completed');assert.equal(record.codex?.version,'codex-cli 0.144.4');
    assert.equal(record.usage[0]?.tokens.totalTokens,135);assert.equal(record.usage[0]?.tokens.reasoningOutputTokens,8);
    assert.deepEqual(record.harnessRunIds,['12345678-1234-4234-8234-123456789012']);
    const evidence=await readFile(join(f.artifacts,record.codex!.evidencePath!), 'utf8');
    assert.ok(!evidence.includes('SHOULD_NOT_PERSIST'));assert.ok(!evidence.includes('Private example text'));
    assert.equal((await stat(join(f.artifacts,record.codex!.outputPath!))).mode&0o077,0);
    assert.equal(await readFile(join(f.artifacts,record.codex!.outputPath!),'utf8'),'Offline fixture final response.');
    assert.ok(!evidence.includes('Offline fixture final response.'));
    await cli(['report','--artifacts-dir',f.artifacts]);
    const report=JSON.parse(await readFile(join(f.artifacts,'benchmark/summary.json'),'utf8'));
    assert.deepEqual(report.missingHarnessRunIds,record.harnessRunIds);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('desktop CLI records manual usage, imports a receipt, grades, and reports without an agent',async()=>{
  const f=await fixture();
  try{
    const usage=join(f.dir,'usage.json');await writeFile(usage,JSON.stringify({sourceLabel:'Desktop task panel',counters:{input_tokens:90,output_tokens:10}}));
    const output=await cli(['record-desktop','--artifacts-dir',f.artifacts,'--case',f.caseFile,'--arm','codex_direct','--model','gpt-6.1-sol','--repetition','1','--usage-file',usage]);
    const id=JSON.parse(output.stdout).benchmarkRunId;
    const costs=join(f.dir,'cost.json');await writeFile(costs,JSON.stringify([{provider:'fal',source:'local receipt',status:'provider_reported',usd:.02,requestId:'offline-receipt'}]));
    await cli(['import-cost','--artifacts-dir',f.artifacts,'--run-id',id,'--file',costs]);
    await cli(['grade','--artifacts-dir',f.artifacts,'--run-id',id,'--outcome','verified_success','--evidence','Offline reviewer fixture']);
    await cli(['report','--artifacts-dir',f.artifacts]);
    const report=JSON.parse(await readFile(join(f.artifacts,'benchmark/summary.json'),'utf8'));
    assert.equal(report.byArm.codex_direct.cost.providerReportedUsd,.02);
    assert.equal(report.byArm.codex_direct.verifiedSuccessRate,1);
    assert.equal(report.byArm.codex_direct.usageByProviderModel['openai-codex/gpt-6.1-sol'].measurementCounts.manual_import,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('offline CLI process failures preserve a failed record with unavailable token usage',async()=>{
  const f=await fixture();
  try{
    await cli(['run','--artifacts-dir',f.artifacts,'--case',f.caseFile,'--arm','codex_direct','--model','gpt-6.1-sol','--codex',join(f.dir,'missing-executable')]);
    const files=await readdir(join(f.artifacts,'benchmark/runs'));
    const record=JSON.parse(await readFile(join(f.artifacts,'benchmark/runs',files[0]!), 'utf8'));
    assert.equal(record.status,'failed');assert.equal(record.errorCode,'codex_spawn_failed');
    assert.equal(record.usage[0].completeness,'unavailable');
    assert.deepEqual(record.usage[0].tokens,{});
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('offline CLI preserves failure categories without raw error text',async()=>{
  const f=await fixture();
  try{
    await writeFile(f.fake,`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.144.4');process.exit(0);}
console.log(JSON.stringify({type:'error',message:'The model is not supported. PRIVATE_SECRET_123'}));
console.log(JSON.stringify({type:'turn.failed',error:{message:'The model is not supported with this account. PRIVATE_SECRET_123'}}));
process.exit(1);
`,{mode:0o700});
    await cli(['run','--artifacts-dir',f.artifacts,'--case',f.caseFile,'--arm','codex_direct','--model','gpt-6.1-sol','--codex',f.fake]);
    const files=await readdir(join(f.artifacts,'benchmark/runs'));
    const record=JSON.parse(await readFile(join(f.artifacts,'benchmark/runs',files[0]!), 'utf8'));
    assert.equal(record.errorCode,'codex_model_unavailable');
    const evidence=await readFile(join(f.artifacts,record.codex.evidencePath),'utf8');
    assert.ok(evidence.includes('codex_model_unavailable'));assert.ok(!evidence.includes('PRIVATE_SECRET_123'));
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('offline CLI timeout retains already observed tokens but marks usage partial',async()=>{
  const f=await fixture();
  try{
    await writeFile(f.fake,`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.144.4');process.exit(0);}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
setInterval(()=>{},1000);
`,{mode:0o700});
    await cli(['run','--artifacts-dir',f.artifacts,'--case',f.caseFile,'--arm','codex_direct','--model','gpt-6.1-sol','--codex',f.fake,'--timeout-ms','1000']);
    const files=await readdir(join(f.artifacts,'benchmark/runs'));
    const record=JSON.parse(await readFile(join(f.artifacts,'benchmark/runs',files[0]!), 'utf8'));
    assert.equal(record.status,'timed_out');assert.equal(record.usage[0].completeness,'partial');assert.equal(record.usage[0].tokens.totalTokens,12);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
