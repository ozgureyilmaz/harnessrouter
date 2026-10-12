import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PROJECT_ROOT} from '../../src/config.js';
import {loadRegistry} from '../../src/registry/loader.js';
import {evaluateOfflineEligibility,parseEvaluationSet,scoreStep,summarizeEvaluation} from '../../src/evaluation/evaluator.js';
import type {HarnessResult} from '../../src/domain/types.js';

const fixturePath=join(PROJECT_ROOT,'fixtures/harness-evaluation-tasks.json');
const set=parseEvaluationSet(JSON.parse(await readFile(fixturePath,'utf8')));
function result(overrides:Partial<HarnessResult>={}):HarnessResult {
  return {schemaVersion:'1.1',runId:'00000000-0000-4000-8000-000000000001',taskId:'evaluation-test',status:'completed',selectedRouteId:'fal-creative:image-fast',selectedHarnessId:'fal-creative',artifacts:[],criterionResults:[],timing:{totalMs:1},cost:{status:'not_applicable',usd:0},...overrides};
}

test('evaluation fixture has 24 valid synthetic cases covering each required category',()=>{
  assert.equal(set.cases.length,24);
  for(const category of ['browser','image','host_defer','unsupported','composed'])assert.ok(set.cases.some(item=>item.category===category));
  for(const item of set.cases)for(const step of item.steps){
    assert.ok(step.task.requiredCapabilities.length>0,`${item.id} has capabilities`);
    assert.ok(step.task.acceptanceCriteria.length>0,`${item.id} has acceptance criteria`);
    assert.ok(step.checks.router.length>0||step.expected.router.status==='defer_to_host',`${item.id} has router checks`);
  }
});

test('evaluation fixture validation rejects missing acceptance checks and duplicate IDs',()=>{
  const missing=structuredClone(set);missing.cases[0]!.steps[0]!.task.acceptanceCriteria=[];
  assert.throws(()=>parseEvaluationSet(missing),/acceptanceCriteria|expected array|at least 1/i);
  const malformed=structuredClone(set);(malformed.cases[0]!.steps[0]!.checks.router[0] as {type:string}).type='made_up_check';
  assert.throws(()=>parseEvaluationSet(malformed),/Invalid harness evaluation set/);
  const duplicate=structuredClone(set);duplicate.cases[1]!.id=duplicate.cases[0]!.id;
  assert.throws(()=>parseEvaluationSet(duplicate),/Duplicate evaluation case id/);
});

test('offline evaluation checks expected eligible routes without provider calls',async()=>{
  const registry=await loadRegistry(join(PROJECT_ROOT,'config/harness-registry.yaml'));
  const report=evaluateOfflineEligibility(set,registry,{'pi-browser':{available:true,provider:'openai-codex'},'fal-creative':{available:true},native:{available:true}});
  assert.equal(report.providerCalls,0);
  assert.equal(report.decisionsCalls,0);
  assert.equal(report.cases,24);
  assert.equal(report.failed,0);
  assert.ok(report.results.some(row=>row.path==='direct'));
  assert.ok(report.results.some(row=>row.path==='router'));
});

test('direct and router checks independently require verified artifacts and route outcomes',()=>{
  const imageCase=set.cases.find(item=>item.id==='C-01')!;const step=imageCase.steps[0]!;
  const image=result({artifacts:[{type:'image',path:'/artifacts/image.png',mimeType:'image/png',verified:true,providerRequestId:'fal-request-1'}]});
  const metadata={'/artifacts/image.png':{width:1600,height:900,mimeType:'image/png',sha256:'abc'}};
  for(const path of ['direct','router'] as const){
    const scored=scoreStep({step,path,result:image,artifactMetadata:metadata});
    assert.ok(scored.length>=5);
    assert.ok(scored.every(check=>check.status==='passed'));
  }
  const failed=scoreStep({step,path:'router',result:image,artifactMetadata:{}});
  assert.ok(failed.some(check=>check.type==='verified_artifact'&&check.status==='failed'));
  const explained=scoreStep({step,path:'router',result:image,artifactMetadata:{'/artifacts/image.png':{verificationError:'artifact_path_denied'}}});
  assert.ok(explained.some(check=>check.type==='verified_artifact'&&check.evidence?.includes('artifact_path_denied')));

  const unsupported=set.cases.find(item=>item.id==='X-01')!.steps[0]!;
  const rejected=result({status:'rejected',selectedHarnessId:null,selectedRouteId:null});
  assert.ok(scoreStep({step:unsupported,path:'router',result:rejected}).every(check=>check.status==='passed'));
});

test('composed evaluation requires recorded observation provenance on the image step',()=>{
  const step=set.cases.find(item=>item.id==='M-01')!.steps[1]!;
  const missing=result({structuredOutput:{providerRequestId:'fal-request-2'}});
  const missingChecks=scoreStep({step,path:'router',result:missing,artifactMetadata:{}});
  assert.ok(missingChecks.some(check=>check.type==='observations_consumed'&&check.status==='failed'));
  const withProvenance=result({structuredOutput:{providerRequestId:'fal-request-2',parentRunId:'parent-run',observationFingerprint:'observed-style-hash'}});
  const passed=scoreStep({step,path:'router',result:withProvenance,artifactMetadata:{}});
  assert.ok(passed.some(check=>check.type==='observations_consumed'&&check.status==='passed'));
});

test('evaluation summary separates failed, unverified, verified and cost counts by path',()=>{
  const summary=summarizeEvaluation([
    {caseId:'C-01',path:'direct',verifiedSuccess:true,checks:[{id:'a',type:'x',status:'passed'}],criteria:[{status:'passed'}],cost:{status:'estimated',usd:.01}},
    {caseId:'B-01',path:'router',verifiedSuccess:false,checks:[{id:'b',type:'x',status:'unverified'}],criteria:[{status:'unverified'}],cost:{status:'unknown',usd:.02}},
    {caseId:'X-01',path:'router',verifiedSuccess:false,checks:[{id:'c',type:'x',status:'failed'}],criteria:[{status:'failed'}],cost:{status:'not_applicable',usd:0}},
  ]);
  assert.equal(summary.direct.verifiedSuccesses,1);
  assert.equal(summary.direct.knownOrEstimatedCostUsd,.01);
  assert.equal(summary.router.unverified,1);
  assert.equal(summary.router.failed,1);
  assert.equal(summary.router.unknownCostCases,1);
  assert.equal(summary.router.knownOrEstimatedCostUsd,.02);
  assert.equal(summary.router.unverifiedCriteria,1);
  assert.equal(summary.router.failedCriteria,1);
});
