import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parsePilotSuite} from '../../src/evaluation/pilot-suite.js';
import {renderPilotReport} from '../../src/evaluation/pilot-report.js';

const root=process.cwd();

test('in-progress report keeps unstarted samples pending instead of marking them skipped',()=>{
  const rendered=renderPilotReport({id:'running',phase:'running',requestedTrials:42,requestedSteps:48,results:[]});
  assert.match(rendered,/0 denenmiş, 0 atlanmış, 48 bekleyen/);
  assert.doesNotMatch(rendered,/eşleşmeyen atlanan trial/);
});

test('pilot suite parses valid v1.0 harness task templates with the agreed 42-trial and 48-step design',async()=>{
  const raw=JSON.parse(await readFile(resolve(root,'fixtures/pilot-suite.json'),'utf8'));
  const suite=parsePilotSuite(raw);
  assert.equal(suite.schemaVersion,'1.1');assert.equal(suite.id,'pilot');assert.equal(suite.repetitions,3);
  assert.equal(suite.cases.length,14);
  assert.equal(suite.cases.reduce((n,c)=>n+c.steps.length,0),16);
  assert.equal(suite.cases.length*suite.repetitions,42);
  assert.equal(suite.cases.reduce((n,c)=>n+c.steps.length,0)*suite.repetitions,48);
  const directPi=suite.cases.filter(c=>c.path==='direct'&&c.steps[0]?.harnessId==='pi-browser');
  assert.equal(directPi.length,6);assert.equal(directPi.filter(c=>c.environment==='controlled').length,4);assert.equal(directPi.filter(c=>c.environment==='public').length,2);
  const directFast=suite.cases.filter(c=>c.path==='direct'&&c.steps[0]?.routeId==='fal-creative:image-fast');
  const directQuality=suite.cases.filter(c=>c.path==='direct'&&c.steps[0]?.routeId==='fal-creative:image-quality');
  assert.equal(directFast.length,3);assert.equal(directQuality.length,3);
  for(const c of suite.cases)for(const step of c.steps){assert.equal(step.task.taskId,'{{taskId}}');assert.ok(step.task.acceptanceCriteria.length>0);assert.ok(step.routeId);}
});

test('controlled fixture HTML is static and long page exceeds the visible-text threshold',async()=>{
  for(const name of ['simple','layout','long','injection']){
    const html=await readFile(resolve(root,`fixtures/eval-pages/${name}.html`),'utf8');
    assert.doesNotMatch(html,/<\s*(script|iframe|form|link|img)\b/i);
    assert.doesNotMatch(html,/\son[a-z]+\s*=|\ssrc\s*=|@import|url\s*\(/i);
  }
  const long=await readFile(resolve(root,'fixtures/eval-pages/long.html'),'utf8');
  const visible=long.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&[^;]+;/g,' ');
  assert.ok(visible.length>12_000);
  assert.match(long,/No fee amount is published/);
  const injection=await readFile(resolve(root,'fixtures/eval-pages/injection.html'),'utf8');
  assert.match(injection,/OVERRIDE_SUCCESS_AGENT_EVAL/);
  assert.match(injection,/CEDAR-27/);
});

test('pilot report handles resolved failures, ungraded judges, empty skipped trials, evidence and separate judge metering',()=>{
  const rendered=renderPilotReport({id:'pilot',startedAt:'2026-10-13T12:00:00Z',requestedTrials:2,requestedSteps:4,results:[
    {caseId:'case-a',repetition:1,category:'composed',path:'router',environment:'controlled',status:'failed',steps:[
      {stepId:'inspect',harnessId:'pi-browser',routeId:'pi-browser:configured',status:'completed',technicalPassed:true,semantic:{status:'scored',passed:true,scores:[{dimension:'answer_correctness',score:4,reason:'Tüm görünür olgular doğru.',evidence:['Başlık doğrudan sayfada.']}],durationMs:20,cost:{status:'estimated',usd:.002},usage:{tokens:{inputTokens:12,outputTokens:8}}},result:{schemaVersion:'1.2',runId:'r-1',taskId:'t-1',status:'completed',selectedRouteId:'pi-browser:configured',selectedHarnessId:'pi-browser',artifacts:[],criterionResults:[],timing:{totalMs:100},cost:{status:'estimated',usd:.01},usage:[{schemaVersion:'1.0',provider:'pi',source:'fixture',measurement:'provider_reported',completeness:'complete',tokens:{inputTokens:30,outputTokens:10}}],tracePath:'runs/a/trace.json'}},
      {stepId:'generate',harnessId:'fal-creative',routeId:'fal-creative:image-fast',status:'completed',technicalPassed:true,technicalChecks:[{name:'artifact_verified',passed:true,evidence:'runs/a/image.png'}],semantic:{status:'scored',passed:false,scores:[{dimension:'brief_adherence',score:2,reason:'İstenen öğe eksik.',evidence:['Görüntüde iki şekil var.']}],durationMs:30,cost:{status:'unknown'},usage:{tokens:{inputTokens:40,outputTokens:20}},tracePath:'runs/a/fal-judge.json'},result:{schemaVersion:'1.2',runId:'r-2',taskId:'t-2',status:'completed',selectedRouteId:'fal-creative:image-fast',selectedHarnessId:'fal-creative',artifacts:[],criterionResults:[],timing:{totalMs:300},cost:{status:'unknown'},tracePath:'runs/a/fal-trace.json'}},
      {stepId:'inspect-ungraded',harnessId:'pi-browser',routeId:'pi-browser:configured',status:'completed',technicalPassed:true,semantic:{status:'unverified',passed:false,reason:'Hakem refusal',error:'judge_refusal',durationMs:50,cost:{status:'unknown'}},result:{schemaVersion:'1.2',runId:'r-3',taskId:'t-3',status:'completed',selectedRouteId:'pi-browser:configured',selectedHarnessId:'pi-browser',artifacts:[],criterionResults:[],timing:{totalMs:200},cost:{status:'not_applicable',usd:0},tracePath:'runs/a/ungraded.json'}},
    ]},
    {caseId:'case-b',repetition:1,category:'image',path:'direct',environment:'generated',status:'skipped',skipReason:'budget_exhausted',steps:[]},
  ]});
  assert.match(rendered,/2\/2 trial kaydı/);assert.match(rendered,/fal-creative/);assert.match(rendered,/pi-browser/);
  assert.match(rendered,/denenmiş, 1 atlanmış, 0 bekleyen adım/u);assert.match(rendered,/Trial atlandı: budget_exhausted/u);
  assert.match(rendered,/Semantik kaldı \| Notlandırılmadı/);assert.match(rendered,/2 \| 1/u);
  assert.match(rendered,/runs\/a\/fal-trace\.json/);assert.match(rendered,/judge_refusal/);
  assert.match(rendered,/brief_adherence: 2\/4/);assert.match(rendered,/brief_adherence \| 2\.00 \| 1/);
  assert.match(rendered,/150 ms/);assert.match(rendered,/35 ms/);assert.match(rendered,/Hakem süresi bu toplama eklenmez/);
  assert.match(rendered,/kalibre edilmemiştir/);assert.match(rendered,/güvenilirliğini .*kanıtlamaz/);
  assert.match(rendered,/Bilinmeyen/u);
});
