import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsageRecord,normalizePiUsage,aggregateBenchmarkRecords,parseCodexJsonl,importHostUsage} from '../../src/observability/metering.js';
import {saveBenchmarkRun,listBenchmarkRuns,importUsageIntoBenchmarkRun,importBenchmarkCosts,gradeBenchmarkRun,buildBenchmarkReport,createDesktopBenchmarkRun} from '../../src/observability/benchmark-store.js';
import type {BenchmarkRunRecord,UsageRecord} from '../../src/domain/types.js';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('normalizes Decisions token counts without adding cached or reasoning subsets twice',()=>{
  const usage=normalizeUsageRecord({provider:'openai',model:'gpt-6-luna',source:'decisions_api',measurement:'provider_reported',counters:{input_tokens:200,output_tokens:30,cached_input_tokens:40,reasoning_tokens:8,total_tokens:230}});
  assert.equal(usage.completeness,'complete');
  assert.deepEqual(usage.tokens,{inputTokens:200,outputTokens:30,cachedInputTokens:40,reasoningOutputTokens:8,totalTokens:230});
});

test('normalizes exclusive Pi input to inclusive input without double counting the reported total',()=>{
  const usage=normalizePiUsage({provider:'openai-codex',model:'gpt-5.5',counters:{input:300,output:40,cacheRead:90,cacheWrite:2,total:432}});
  assert.equal(usage.tokens.inputTokens,392);
  assert.equal(usage.tokens.totalTokens,432);
  assert.equal(usage.tokens.cachedInputTokens,90);
  assert.equal(usage.tokens.cacheWriteInputTokens,2);
});

test('Codex failures without usage and missing counters in any turn make the sum partial',()=>{
  const parsed=parseCodexJsonl('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}\n{"type":"turn.failed"}');
  assert.equal(parsed.usage.completeness,'partial');
  assert.equal(parsed.usage.tokens.totalTokens,110);
});

test('desktop import replaces host usage rather than adding the same task twice',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-import-replace-'));
  try{
    const record=run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','codex_direct','ungraded',[
      normalizeUsageRecord({provider:'openai-codex',model:'gpt-6-sol',source:'codex_cli_jsonl',measurement:'platform_estimated',counters:{input_tokens:100,output_tokens:10}})
    ],[]);
    await saveBenchmarkRun(root,record);
    const updated=await importUsageIntoBenchmarkRun(root,record.benchmarkRunId,importHostUsage({model:'gpt-6-sol',counters:{input_tokens:120,output_tokens:10},sourceLabel:'Task usage'}));
    assert.equal(updated.usage.length,1);
    assert.equal(updated.usage[0]?.tokens.totalTokens,130);
    assert.equal(updated.usage[0]?.measurement,'manual_import');
    assert.equal(updated.usageImportHistory?.length,1);
    const audit=JSON.parse(await readFile(join(root,updated.usageImportHistory![0]!.evidencePath),'utf8'));
    assert.equal(audit.previousHostUsage[0].tokens.totalTokens,110);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('empty cost data is unavailable even after an explicitly successful task',()=>{
  const summary=aggregateBenchmarkRecords([run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','codex_direct','verified_success',[],[])]);
  assert.equal(summary.byArm.codex_direct?.cost.perVerifiedSuccessUsd.status,'unavailable');
  assert.equal(summary.byArm.codex_direct?.cost.perVerifiedSuccessUsd.providerReportedUsd,undefined);
});

test('imports direct provider costs and rejects reimport of a billed request',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-import-cost-'));
  try{
    const record=run('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','codex_direct','ungraded',[],[]);await saveBenchmarkRun(root,record);
    const receipt={provider:'fal',model:'fal-ai/flux-2',source:'Provider receipt',requestId:'req-1',status:'provider_reported' as const,usd:.015};
    const result=await importBenchmarkCosts(root,record.benchmarkRunId,[receipt]);
    assert.equal(result.costComponents[0]?.usd,.015);
    await assert.rejects(()=>importBenchmarkCosts(root,record.benchmarkRunId,[receipt]),/already imported/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('aggregation preserves usage provenance and separates cases with changed prompts',()=>{
  const a=run('cccccccc-cccc-4ccc-8ccc-cccccccccccc','codex_direct','ungraded',[usage('openai',10,1)],[]);
  const b={...a,benchmarkRunId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',promptHash:'b'.repeat(64)};
  const summary=aggregateBenchmarkRecords([a,b]);
  assert.equal(summary.byArm.codex_direct?.usageByProviderModel['openai/unknown']?.measurementCounts.provider_reported,2);
  assert.equal(Object.keys(summary.byCaseAndArm).length,2);
});

test('keeps missing and partial usage distinct from zero usage',()=>{
  const partial=normalizeUsageRecord({provider:'openai-codex',source:'codex_app_import',measurement:'manual_import',counters:{total_tokens:420}});
  const unavailable=normalizeUsageRecord({provider:'pi',source:'pi_session_stats',measurement:'unavailable'});
  assert.equal(partial.completeness,'partial');
  assert.equal(partial.tokens.totalTokens,420);
  assert.equal(unavailable.completeness,'unavailable');
  assert.deepEqual(unavailable.tokens,{});
});

test('parses Codex JSONL usage across turns while ignoring content and malformed lines',()=>{
  const parsed=parseCodexJsonl([
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"total_tokens":120}}',
    'not-json',
    '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"private answer"}}',
  ].join('\n'),'gpt-6-sol');
  assert.equal(parsed.threadId,'thread-1');
  assert.equal(parsed.usage.completeness,'complete');
  assert.deepEqual(parsed.usage.tokens,{inputTokens:150,outputTokens:25,cachedInputTokens:10,totalTokens:175});
  assert.equal(parsed.completedTurns,2);
  assert.equal(parsed.malformedLines,1);
  assert.ok(!JSON.stringify(parsed).includes('private answer'));
});

test('marks Codex runs with no emitted usage as unavailable rather than zero',()=>{
  const parsed=parseCodexJsonl('{"type":"thread.started","thread_id":"thread-2"}\n{"type":"turn.completed"}','gpt-6-sol');
  assert.equal(parsed.usage.completeness,'unavailable');
  assert.deepEqual(parsed.usage.tokens,{});
});

test('links only structured HarnessRouter route_task results from Codex JSONL',()=>{
  const runId='44444444-4444-4444-8444-444444444444';
  const parsed=parseCodexJsonl(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'harnessrouter',tool:'route_task',result:{structuredContent:{runId,selectedHarnessId:'fal-creative',selectedModelId:'fal-ai/flux-2',usage:[usage('openai',10,1)],costComponents:cost('rate_estimate',.012),artifacts:[{type:'image',providerRequestId:'fal-req-1'}]}}}}),'gpt-6-sol');
  assert.deepEqual(parsed.harnessRunIds,[runId]);
  assert.equal(parsed.usageFromHarness[0]?.tokens.totalTokens,11);
  assert.equal(parsed.costsFromHarness[0]?.usd,.012);
  assert.deepEqual(parsed.mediaFromHarness,[{provider:'fal',model:'fal-ai/flux-2',kind:'image',count:1,requestIds:['fal-req-1']}]);
});

test('parses the pinned Codex 0.144.4 wire format including reasoning and snake-case MCP results',()=>{
  const id='99999999-9999-4999-8999-999999999999';
  const events=[{type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:25,output_tokens:20,reasoning_output_tokens:12}},
    {type:'item.completed',item:{type:'mcp_tool_call',server:'router-alias',tool:'route_task',status:'completed',result:{content:[],structured_content:{runId:id,usage:[],costComponents:[],artifacts:[]}}}}];
  const result=parseCodexJsonl(events.map(item=>JSON.stringify(item)).join('\n'),'gpt-6.1-sol','router-alias');
  assert.equal(result.usage.tokens.reasoningOutputTokens,12);
  assert.equal(result.usage.tokens.totalTokens,120);
  assert.deepEqual(result.harnessRunIds,[id]);
});

test('aggregates every attempt and marks cost per verified success partial when a failure has unknown cost',()=>{
  const records:BenchmarkRunRecord[]=[
    run('11111111-1111-4111-8111-111111111111','codex_direct','verified_success',[usage('openai-codex',100,20)],cost('provider_reported',0.1)),
    run('22222222-2222-4222-8222-222222222222','codex_direct','verified_failure',[usage('openai-codex',300,40)],cost('unknown')),
    {...run('33333333-3333-4333-8333-333333333333','codex_harnessrouter','verified_success',[usage('openai-codex',50,10),usage('openai-decisions',20,2)],cost('rate_estimate',0.03)),mediaOutputs:[{provider:'fal',model:'fal-ai/flux-2',kind:'image',count:1,requestIds:['fal-request']} ]},
  ];
  const summary=aggregateBenchmarkRecords(records);
  const direct=summary.byArm.codex_direct!;
  assert.equal(direct.attempts,2);
  assert.equal(direct.verifiedSuccesses,1);
  assert.equal(direct.timing.medianCompletedMs,1000);
  assert.equal(direct.usageByProviderModel['openai-codex/unknown']?.totalTokens,460);
  assert.equal(direct.usageByProviderModel['openai-codex/unknown']?.meanTotalTokensPerTask,230);
  assert.equal(direct.cost.unknownComponents,1);
  assert.equal(direct.cost.perVerifiedSuccessUsd.status,'partial');
  assert.equal(direct.cost.perVerifiedSuccessUsd.providerReportedUsd,0.1);
  assert.equal(summary.byArm.codex_harnessrouter?.mediaByProviderModel['fal/fal-ai/flux-2']?.images,1);
  assert.equal(summary.byCaseAndArm['case-1']?.codex_direct?.attempts,2);
});

test('imports desktop Codex usage with manual provenance and keeps subscription dollars unknown',()=>{
  const imported=importHostUsage({provider:'openai-codex',model:'gpt-6-sol',counters:{inputTokens:70,outputTokens:10,totalTokens:80},sourceLabel:'Codex task usage panel'});
  assert.equal(imported.source,'codex_app_import');
  assert.equal(imported.measurement,'manual_import');
  assert.equal(imported.completeness,'complete');
});

test('stores benchmark runs locally and imports desktop usage exactly once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-benchmark-'));
  const record=run('11111111-1111-4111-8111-111111111111','codex_direct','ungraded',[],[]);
  try {
    await saveBenchmarkRun(root,record);
    const imported=await importUsageIntoBenchmarkRun(root,record.benchmarkRunId,importHostUsage({model:'gpt-6-sol',counters:{input_tokens:12,output_tokens:3},sourceLabel:'Desktop usage panel'}));
    assert.equal(imported.usage[0]?.measurement,'manual_import');
    assert.equal((await listBenchmarkRuns(root)).length,1);
    await assert.rejects(()=>importUsageIntoBenchmarkRun(root,record.benchmarkRunId,importHostUsage({model:'gpt-6-sol',counters:{input_tokens:1,output_tokens:1},sourceLabel:'Desktop usage panel'})),/already imported/);
    const graded=await gradeBenchmarkRun(root,record.benchmarkRunId,'verified_success','All acceptance criteria passed against the saved output.');
    assert.equal(graded.outcome,'verified_success');
    await assert.rejects(()=>gradeBenchmarkRun(root,record.benchmarkRunId,'verified_failure','Changed my mind.'),/already has a verified outcome/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('creates desktop Codex records with a prompt hash and manually imported usage only',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-desktop-benchmark-'));
  try{
    const record=await createDesktopBenchmarkRun(root,{caseId:'desktop-case',arm:'codex_direct',repetition:2,prompt:'Keep this prompt out of the record.',model:'gpt-6-sol',sourceLabel:'Codex task usage panel',counters:{input_tokens:90,output_tokens:12,total_tokens:102},durationMs:4500,threadId:'thread-desktop'});
    assert.equal(record.outcome,'ungraded');
    assert.equal(record.durationMs,4500);
    assert.equal(record.usage[0]?.measurement,'manual_import');
    assert.equal(record.codex?.threadId,'thread-desktop');
    assert.ok(record.promptHash.length===64);
    assert.ok(!JSON.stringify(record).includes('Keep this prompt'));
    assert.deepEqual(record.costComponents,[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('report joins linked HarnessResult usage, image units, and rate estimates',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-benchmark-link-'));
  const harnessRunId='55555555-5555-4555-8555-555555555555';
  try{
    const record=run('66666666-6666-4666-8666-666666666666','codex_harnessrouter','ungraded',[],[]);
    record.harnessRunIds=[harnessRunId];
    await saveBenchmarkRun(root,record);
    const runDir=join(root,harnessRunId);await mkdir(runDir,{recursive:true});
    await writeFile(join(runDir,'result.json'),JSON.stringify({schemaVersion:'1.2',runId:harnessRunId,taskId:'router-task',status:'completed',selectedRouteId:'fal-creative:image-quality',selectedHarnessId:'fal-creative',selectedModelId:'fal-ai/flux-2',artifacts:[{type:'image',verified:true,providerRequestId:'fal-image-req'}],criterionResults:[],timing:{totalMs:100},cost:{status:'estimated',usd:.012},usage:[usage('openai-decisions',220,2)],costComponents:[{provider:'fal',model:'fal-ai/flux-2',source:'fal image unit estimate',status:'rate_estimate',usd:.012}]}));
    const report=await buildBenchmarkReport(root) as {linkedHarnessRuns:number;costAccounting:{subscriptionUsdAllocated:boolean};byArm:Record<string,{usageByProviderModel:Record<string,{totalTokens?:number}>;mediaByProviderModel:Record<string,{images:number}>;costByProviderModel:Record<string,{rateEstimateUsd:number}>;cost:{rateEstimateUsd:number}}>};
    assert.equal(report.linkedHarnessRuns,1);
    assert.equal(report.byArm.codex_harnessrouter?.usageByProviderModel['openai-decisions/unknown']?.totalTokens,222);
    assert.equal(report.byArm.codex_harnessrouter?.mediaByProviderModel['fal/fal-ai/flux-2']?.images,1);
    assert.equal(report.byArm.codex_harnessrouter?.cost.rateEstimateUsd,.012);
    assert.equal(report.byArm.codex_harnessrouter?.costByProviderModel['fal/fal-ai/flux-2']?.rateEstimateUsd,.012);
    assert.equal(report.costAccounting.subscriptionUsdAllocated,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('marks missing linked harness evidence as unavailable usage and unknown cost',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-benchmark-missing-'));
  const missing='77777777-7777-4777-8777-777777777777';
  try{
    const record=run('88888888-8888-4888-8888-888888888888','codex_harnessrouter','verified_success',[],[]);
    record.harnessRunIds=[missing];await saveBenchmarkRun(root,record);
    const report=await buildBenchmarkReport(root) as {missingHarnessRunIds:string[];byArm:Record<string,{usageByProviderModel:Record<string,{unavailableRecords:number}>;cost:{unknownComponents:number;perVerifiedSuccessUsd:{status:string}}}>};
    assert.deepEqual(report.missingHarnessRunIds,[missing]);
    assert.equal(report.byArm.codex_harnessrouter?.usageByProviderModel['harnessrouter/unknown']?.unavailableRecords,1);
    assert.equal(report.byArm.codex_harnessrouter?.cost.unknownComponents,1);
    assert.equal(report.byArm.codex_harnessrouter?.cost.perVerifiedSuccessUsd.status,'unavailable');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('report marks unpriced host subscription usage unknown beside a metered fal subtotal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-unpriced-host-'));
  try{
    const record=run('99999999-9999-4999-8999-999999999999','codex_harnessrouter','verified_success',[usage('openai-codex',100,10)],[{provider:'fal',source:'catalog',status:'rate_estimate',usd:.012}]);
    await saveBenchmarkRun(root,record);
    const report=await buildBenchmarkReport(root) as {byArm:Record<string,{cost:{unknownComponents:number;perVerifiedSuccessUsd:{status:string;rateEstimateUsd:number}}}>};
    assert.equal(report.byArm.codex_harnessrouter?.cost.unknownComponents,1);
    assert.equal(report.byArm.codex_harnessrouter?.cost.perVerifiedSuccessUsd.status,'partial');
    assert.equal(report.byArm.codex_harnessrouter?.cost.perVerifiedSuccessUsd.rateEstimateUsd,.012);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a provider receipt supersedes a linked price estimate for the same request without double billing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-billing-dedupe-'));
  const id='11111111-aaaa-4aaa-8aaa-111111111111';
  try{
    const record=run('22222222-aaaa-4aaa-8aaa-222222222222','codex_harnessrouter','verified_success',[],[{provider:'fal',source:'receipt',status:'provider_reported',requestId:'fal-request',usd:.015}]);
    record.harnessRunIds=[id];await saveBenchmarkRun(root,record);await mkdir(join(root,id));
    await writeFile(join(root,id,'result.json'),JSON.stringify({schemaVersion:'1.2',runId:id,taskId:'image',status:'completed',selectedRouteId:'fal-creative:image-fast',selectedHarnessId:'fal-creative',artifacts:[],criterionResults:[],timing:{totalMs:1},cost:{status:'estimated',usd:.012},usage:[],costComponents:[{provider:'fal',source:'estimate',status:'rate_estimate',requestId:'fal-request',usd:.012}]}));
    const report=await buildBenchmarkReport(root) as {byArm:Record<string,{cost:{providerReportedUsd:number;rateEstimateUsd:number}}>};
    assert.equal(report.byArm.codex_harnessrouter?.cost.providerReportedUsd,.015);
    assert.equal(report.byArm.codex_harnessrouter?.cost.rateEstimateUsd,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

function usage(provider:string,input:number,output:number):UsageRecord {
  return normalizeUsageRecord({provider,source:'test_fixture',measurement:'provider_reported',counters:{inputTokens:input,outputTokens:output}});
}
function cost(status:'provider_reported'|'rate_estimate'|'unknown',usd?:number){return [{provider:'test',source:'fixture',status,...(usd===undefined?{}:{usd})}];}
function run(id:string,arm:string,outcome:BenchmarkRunRecord['outcome'],usageRecords:UsageRecord[],costComponents:BenchmarkRunRecord['costComponents']):BenchmarkRunRecord {
  return {schemaVersion:'1.0',benchmarkRunId:id,caseId:'case-1',arm,repetition:1,promptHash:'a'.repeat(64),startedAt:'2026-10-12T10:00:00.000Z',durationMs:1000,status:outcome==='verified_failure'?'failed':'completed',outcome,harnessRunIds:[],usage:usageRecords,costComponents};
}
