import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Budget,Cost} from '../domain/types.js';
import {RouterError} from '../domain/errors.js';
interface Entry {id:string;runId:string;usd:number;label:string;state:'reserved'|'settled';cost?:Cost;scopeId?:string;scopeCapUsd?:number}
export interface BudgetScope {id:string;capUsd:number}
export class BudgetLedger {
  private entries:Entry[]=[];
  private lockPath:string;
  private constructor(private root:string,readonly capUsd:number,readonly scope?:BudgetScope) {this.lockPath=join(root,'budget.lock');}
  static async open(root:string,capUsd:number,scope?:BudgetScope) {
    if(!Number.isFinite(capUsd)||capUsd<0||scope&&(!scope.id||!Number.isFinite(scope.capUsd)||scope.capUsd<0))throw new RouterError('budget_invalid','Budget caps must be finite nonnegative values');
    await mkdir(root,{recursive:true,mode:0o700});const ledger=new BudgetLedger(root,capUsd,scope);
    await ledger.reload();return ledger;
  }
  private async reload() {
    const ledger=this;const root=this.root;
    try {ledger.entries=JSON.parse(await readFile(join(root,'budget.json'),'utf8')).entries;}
    catch (e) {if ((e as NodeJS.ErrnoException).code!=='ENOENT')throw new RouterError('budget_corrupt','Budget ledger cannot be read; refusing to reset spending history');}
    if (!Array.isArray(ledger.entries)||ledger.entries.some(e=>!Number.isFinite(e.usd)||e.usd<0||e.scopeId!==undefined&&(typeof e.scopeId!=='string'||!Number.isFinite(e.scopeCapUsd)||e.scopeCapUsd!<0))) throw new RouterError('budget_corrupt','Invalid budget entries');
    if(ledger.scope&&ledger.entries.some(e=>e.scopeId===ledger.scope!.id&&e.scopeCapUsd!==ledger.scope!.capUsd))throw new RouterError('budget_invalid','An existing evaluation scope cannot change its authorized cap');
  }
  get committedUsd() {return this.entries.reduce((n,e)=>n+e.usd,0);}
  get scopeCommittedUsd() {return this.scope?this.entries.filter(e=>e.scopeId===this.scope!.id).reduce((n,e)=>n+e.usd,0):this.committedUsd;}
  get remainingUsd() {return Math.max(0,Math.min(this.capUsd-this.committedUsd,this.scope?this.scope.capUsd-this.scopeCommittedUsd:Number.POSITIVE_INFINITY));}
  unresolvedForRun(runId:string) {return this.entries.some(e=>e.runId===runId&&(e.state==='reserved'||!e.cost||e.cost.status==='unknown'));}
  async refresh(){await this.chain;await this.reload();}
  costForRun(runId:string):Cost {
    const entries=this.entries.filter(e=>e.runId===runId);
    if(!entries.length)return {status:'not_applicable',usd:0,details:'No provider spending was reserved'};
    if(entries.some(e=>e.state==='reserved'||!e.cost||e.cost.status==='unknown'))return {status:'unknown',details:'At least one provider charge is unresolved; upper-bound commitment is retained'};
    return {status:entries.some(e=>e.cost?.status==='estimated')?'estimated':'known',usd:entries.reduce((n,e)=>n+(e.cost?.usd??0),0),details:'Combined provider accounting from settled reservations'};
  }
  private chain=Promise.resolve();
  private async persist() {
    const content=JSON.stringify({capUsd:this.capUsd,committedUsd:this.committedUsd,entries:this.entries},null,2);
    const file=join(this.root,'budget.json');await writeFile(file+'.tmp',content,{mode:0o600});await rename(file+'.tmp',file);
  }
  private transaction<T>(operation:()=>Promise<T>):Promise<T> {
    const pending=this.chain.then(async()=>{
      const started=Date.now();
      for(;;){
        try{const handle=await open(this.lockPath,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();break;}
        catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
          if(Date.now()-started>5000)throw new RouterError('budget_locked','Budget mutation lock is busy; inspect the recorded PID before clearing a confirmed stale lock');
          await new Promise(r=>setTimeout(r,25));}
      }
      try{await this.reload();return await operation();}finally{await unlink(this.lockPath);}
    });
    this.chain=pending.then(()=>undefined,()=>undefined);return pending;
  }
  forRun(runId:string,capUsd:number):Budget {
    const ledger=this;return {
      get remainingUsd(){return Math.max(0,Math.min(ledger.remainingUsd,capUsd-ledger.entries.filter(e=>e.runId===runId).reduce((n,e)=>n+e.usd,0)));},
      async reserve(usd,label){
        return ledger.transaction(async()=>{
          if (!Number.isFinite(usd)||usd<0||usd>this.remainingUsd+1e-10) throw new RouterError('budget_exceeded',`Insufficient authorized budget for ${label}`);
          const id=randomUUID();ledger.entries.push({id,runId,usd,label,state:'reserved',...(ledger.scope?{scopeId:ledger.scope.id,scopeCapUsd:ledger.scope.capUsd}:{})});await ledger.persist();return id;
        });
      },
      async settle(id,cost){return ledger.transaction(async()=>{const entry=ledger.entries.find(e=>e.id===id&&e.runId===runId);if(!entry)throw new RouterError('budget_invalid','Unknown reservation');
        if (cost.usd!==undefined && (!Number.isFinite(cost.usd)||cost.usd<0||cost.usd>entry.usd+1e-10)) throw new RouterError('budget_exceeded','Reported charge exceeds reserved upper bound');
        // Unknown or merely estimated charges retain their upper-bound commitment.
        if ((cost.status==='known'||cost.status==='not_applicable')&&cost.usd!==undefined) entry.usd=cost.usd;
        entry.state='settled';entry.cost=cost;await ledger.persist();
      });
      }
    };
  }
  async close(){await this.chain;}
}
