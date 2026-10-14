import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetLedger} from '../../src/observability/budget.js';

test('eval scope shares the session ledger and bounds reservations across multiple run IDs and restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-eval-budget-'));
  try{
    const one=await BudgetLedger.open(root,5,{id:'pilot-test',capUsd:.10});
    const a=one.forRun('a',.10);const reservation=await a.reserve(.06,'First evaluator request');await a.settle(reservation,{status:'estimated',usd:.01});
    assert.equal(one.scopeCommittedUsd,.06);await one.close();
    const two=await BudgetLedger.open(root,5,{id:'pilot-test',capUsd:.10});
    await assert.rejects(two.forRun('b',.10).reserve(.05,'Would exceed evaluation cap'),/Insufficient authorized budget/);
    const b=two.forRun('b',.10);const id=await b.reserve(.03,'Second request');await b.settle(id,{status:'unknown'});
    assert.equal(two.unresolvedForRun('b'),true);assert.equal(two.unresolvedForRun('pi-oauth-no-reservation'),false);
    const global=await BudgetLedger.open(root,5);assert.equal(global.committedUsd,.09);
    await assert.rejects(BudgetLedger.open(root,5,{id:'pilot-test',capUsd:.20}),/cannot change/);
    const json=JSON.parse(await readFile(join(root,'budget.json'),'utf8'));assert.ok(json.entries.every((entry:{scopeId:string})=>entry.scopeId==='pilot-test'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('two evaluator clients cannot reserve beyond a shared scope concurrently',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hr-eval-concurrent-'));
  try{
    const a=await BudgetLedger.open(root,5,{id:'shared',capUsd:.10});const b=await BudgetLedger.open(root,5,{id:'shared',capUsd:.10});
    const outcomes=await Promise.allSettled([a.forRun('a',1).reserve(.07,'a'),b.forRun('b',1).reserve(.07,'b')]);
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    await a.refresh();assert.equal(a.scopeCommittedUsd,.07);
  }finally{await rm(root,{recursive:true,force:true});}
});
