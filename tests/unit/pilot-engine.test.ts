import test from 'node:test';
import assert from 'node:assert/strict';
import {executePilot,type PilotStepOutcome} from '../../src/evaluation/pilot-engine.js';
import type {PilotSuite} from '../../src/evaluation/pilot-suite.js';

function suite(composed=false):PilotSuite {
  const task={schemaVersion:'1.0' as const,taskId:'placeholder',prompt:'Synthetic task',requirements:['image'],requiredCapabilities:['media.text_to_image'],acceptanceCriteria:['Image decodes'],desiredOutput:'image' as const};
  const step={id:'first',harnessId:'fal-creative' as const,task,expectedFacts:[],dimensions:['brief_adherence']};
  return {schemaVersion:'1.1',id:'offline-test',repetitions:3,cases:[{id:'a',category:composed?'composed':'image',path:composed?'router':'direct',environment:'generated',steps:composed?[step,{...step,id:'second',inheritPreviousObservations:true}]:[step]}]};
}
function outcome(stepId:string,overrides:Partial<PilotStepOutcome>={}):PilotStepOutcome {return {stepId,harnessId:'fal-creative',status:'completed',technicalPassed:true,semantic:{status:'scored',passed:true},...overrides};}

test('offline pilot orchestration continues after resolved failure to keep all requested samples',async()=>{
  let calls=0;const report=await executePilot(suite(),{execute:async(_c,step)=>{calls++;return outcome(step.id,calls===1?{status:'failed',technicalPassed:false,semantic:undefined}:{});},stopReason:async()=>undefined,checkpoint:async()=>{}});
  assert.equal(calls,3);assert.deepEqual(report.results.map(r=>r.status),['failed','completed','completed']);
});

test('offline pilot orchestration stops after ambiguous submit and reports remaining samples as skipped',async()=>{
  let calls=0;const report=await executePilot(suite(),{execute:async(_c,step)=>{calls++;return outcome(step.id,{status:'failed',technicalPassed:false,stopReason:'unresolved_provider_operation'});},stopReason:async()=>undefined,checkpoint:async()=>{}});
  assert.equal(calls,1);assert.equal(report.stopReason,'unresolved_provider_operation');assert.deepEqual(report.results.map(r=>r.status),['failed','skipped','skipped']);
});

test('offline composed workflow skips only its dependent step after resolved upstream failure',async()=>{
  const seen:string[]=[];const report=await executePilot(suite(true),{execute:async(_c,step,rep)=>{seen.push(`${rep}:${step.id}`);return outcome(step.id,rep===1?{status:'failed',technicalPassed:false,semantic:undefined}:{});},stopReason:async()=>undefined,checkpoint:async()=>{}});
  assert.deepEqual(seen,['1:first','2:first','2:second','3:first','3:second']);assert.equal(report.results[0]!.steps[1]!.status,'skipped');
});

test('offline cancellation between composed steps prevents the second request',async()=>{
  let cancelled=false,calls=0;const report=await executePilot(suite(true),{execute:async(_c,step)=>{calls++;cancelled=true;return outcome(step.id);},stopReason:async()=>cancelled?'cancelled_by_user':undefined,checkpoint:async()=>{}});
  assert.equal(calls,1);assert.equal(report.results[0]!.steps[1]!.status,'skipped');assert.equal(report.stopReason,'cancelled_by_user');
});
