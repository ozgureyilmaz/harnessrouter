import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,PROJECT_ROOT} from '../../src/config.js';
import {createRouter} from '../../src/create-router.js';
import {runProcess,workerEnvironment} from '../../src/workers/process.js';
import type {WorkerKind} from '../../src/workers/types.js';
const optedIn=process.env.HARNESSROUTER_LIVE_WORKERS==='1'&&process.env.HARNESSROUTER_ACCEPT_UNKNOWN_COST==='1';
for(const kind of ['codex','claude-code','opencode','pi'] as WorkerKind[]){
  test(`LIVE ${kind} workspace worker (native account, real patch, explicit unknown-cost opt-in)`,{skip:optedIn?false:'No worker/model call: requires HARNESSROUTER_LIVE_WORKERS=1 and HARNESSROUTER_ACCEPT_UNKNOWN_COST=1 plus an enabled configured profile.'},async t=>{
    const config=loadConfig();
    const profile=config.workerProfiles?.find(p=>p.adapter===kind&&p.enabled&&p.allowExecution&&p.allowUnknownCost);
    if(!config.allowExecution||config.dryRun||!profile){t.skip('Explicit trusted live configuration and an enabled unknown-cost profile are required');return;}
    const source=await realpath(await mkdtemp(join(tmpdir(),`hr-live-${kind}-`)));
    t.after(()=>rm(source,{recursive:true,force:true}));
    await runProcess('git',['init','-q'],{cwd:source,env:workerEnvironment()});
    await writeFile(join(source,'greeting.txt'),'before\n');
    await runProcess('git',['add','greeting.txt'],{cwd:source,env:workerEnvironment()});
    const root=join(PROJECT_ROOT,'artifacts','live-workers',randomUUID());await mkdir(root,{recursive:true,mode:0o700});
    const router=await createRouter({overrides:{...config,selector:'local',workerProfiles:[profile],workspaceRoots:[source],artifactsDir:root,allowPaid:false,sessionUsd:0}});
    t.after(()=>router.close());
    const health=await router.health();
    if(!health[profile.id]?.available){t.skip(`Runtime unavailable: ${health[profile.id]?.reason??'unknown'}`);return;}
    const result=await router.routeTask({schemaVersion:'1.1',taskId:randomUUID(),prompt:'Change greeting.txt to exactly after followed by a newline. Make no other changes. Return a short completion message.',requirements:['coding'],acceptanceCriteria:['Patch applies to captured baseline'],desiredOutput:'patch',preferredRouteId:`${profile.id}:configured`,allowUnknownCost:true,workspace:{root:source,mode:'patch'},timeoutMs:120000});
    assert.equal(result.status,'completed',JSON.stringify(result.error));
    assert.equal(result.selectedHarnessId,profile.id);
    assert.equal(await readFile(join(source,'greeting.txt'),'utf8'),'before\n');
    const patch=result.artifacts.find(artifact=>artifact.type==='patch');assert.ok(patch?.verified&&patch.path);
    assert.match(await readFile(patch.path,'utf8'),/\+after/);
    assert.equal(result.criterionResults[0]?.status,'passed');
    assert.ok(result.tracePath); // Evidence is retained under ignored artifacts/live-workers.
  });
}
