import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {validateTask,validateResult,validateRegistry,validateTrace} from '../../src/domain/schemas.js';
import {BudgetLedger} from '../../src/observability/budget.js';
import {verifyImage,isPublicAddress,assertArtifactPath} from '../../src/observability/artifacts.js';
import {RunTrace,redact} from '../../src/observability/trace.js';

test('offline: all supplied schemas are enforced',()=>{
  const task={schemaVersion:'1.0',taskId:'T1',prompt:'Hello',requirements:['coding'],acceptanceCriteria:[]};
  validateTask(task);validateTask({...task,requiredCapabilities:['browser.extract']});
  assert.throws(()=>validateTask({...task,requiredCapabilities:['']}));
  assert.throws(()=>validateTask({...task,unknown:true}));assert.throws(()=>validateTask({...task,maxCostUsd:-1}));
  assert.throws(()=>validateResult({status:'completed'}));assert.throws(()=>validateRegistry({version:2,harnesses:[]}));
  validateResult({schemaVersion:'1.1',runId:'r',taskId:'T1',status:'completed',selectedRouteId:'pi-browser:configured',artifacts:[],timing:{totalMs:1},cost:{status:'not_applicable'},criterionResults:[{criterion:'Readable screenshot',status:'unverified',verifier:'none'}]});
  validateResult({schemaVersion:'1.2',runId:'r2',taskId:'T1',status:'completed',selectedRouteId:'pi-browser:configured',artifacts:[],timing:{totalMs:1},cost:{status:'unknown'},criterionResults:[],usage:[{schemaVersion:'1.0',provider:'openai-codex',source:'pi_session_stats',measurement:'provider_reported',completeness:'partial',tokens:{totalTokens:12}}],costComponents:[{provider:'fal',source:'published price',status:'rate_estimate',usd:0.01}]});
  assert.throws(()=>validateResult({schemaVersion:'1.1',runId:'r',taskId:'T1',status:'completed',selectedRouteId:'pi-browser:configured',artifacts:[],timing:{totalMs:1},cost:{status:'not_applicable'},criterionResults:[{criterion:'Readable screenshot',status:'done',verifier:'none'}]}));
  assert.throws(()=>validateResult({schemaVersion:'1.0',runId:'r',taskId:'T1',status:'completed',selectedRouteId:'pi-browser:configured',artifacts:[],timing:{totalMs:1},cost:{status:'not_applicable'}}));
  validateTrace({schemaVersion:'1.0',runId:'r',eligibleRouteIds:[],decisionStatus:'no_candidates'});
});
test('offline: concurrent reservations obey cap and unknown spend survives restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-budget-'));let ledger=await BudgetLedger.open(root,1);
  try {
    const b=ledger.forRun('r',.6);const reserved=await b.reserve(.4,'mock provider');
    await b.settle(reserved,{status:'unknown'});assert.equal(ledger.committedUsd,.4);
    const calls=await Promise.allSettled([b.reserve(.2,'a'),b.reserve(.2,'b')]);assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);
    const other=await BudgetLedger.open(root,1);
    const shared=await Promise.allSettled([ledger.forRun('shared-a',1).reserve(.3,'a'),other.forRun('shared-b',1).reserve(.3,'b')]);
    assert.equal(shared.filter(r=>r.status==='fulfilled').length,1);await other.close();
    await ledger.close();ledger=await BudgetLedger.open(root,1);assert.ok(Math.abs(ledger.committedUsd-.9)<1e-9);
    await assert.rejects(()=>ledger.forRun('r',.6).reserve(.1,'too much'),/Insufficient/);
  }finally{await ledger.close();await rm(root,{recursive:true,force:true});}
});
test('offline: image verifier decodes real bytes and checks aspect ratio',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-image-'));const path=join(root,'image.png');
  try{await sharp({create:{width:160,height:90,channels:3,background:'#123456'}}).png().toFile(path);
    const evidence=await verifyImage(path,{expectedRatio:16/9});assert.equal(evidence.width,160);assert.equal(evidence.mimeType,'image/png');assert.ok(evidence.sha256.length===64);
    await assert.rejects(()=>verifyImage(path,{expectedRatio:1}),/Aspect/);
    await writeFile(path,'<html>error</html>');await assert.rejects(()=>verifyImage(path),/image|format/i);
    await assert.rejects(()=>assertArtifactPath('/etc/hosts',root),/under the run/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('offline: SSRF rejects local/reserved networks',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.20.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fe80::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('offline: secrets are removed from durable traces',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-trace-'));const prior=process.env.FAL_KEY;process.env.FAL_KEY='never-print-this-token';
  try {const trace=new RunTrace(root,'run');await trace.event('mock',{authorization:'Bearer secret',message:process.env.FAL_KEY});
    const text=await readFile(trace.path,'utf8');assert.ok(!text.includes('never-print'));assert.ok(!text.includes('Bearer secret'));
    assert.deepEqual(redact({cookie:'private'}),{cookie:'[REDACTED]'});
  }finally{if(prior===undefined)delete process.env.FAL_KEY;else process.env.FAL_KEY=prior;await rm(root,{recursive:true,force:true});}
});
