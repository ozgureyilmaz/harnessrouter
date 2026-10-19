import type {HarnessAdapter,Health,HarnessTask,ExecutionContext,AdapterResult} from '../domain/types.js';
import {RouterError} from '../domain/errors.js';
/** Missing optional specialists never prevent the keyless MCP core from starting. */
export class LazyHarnessAdapter implements HarnessAdapter {
  private loaded?:Promise<HarnessAdapter>;
  constructor(readonly id:string,private factory:()=>Promise<HarnessAdapter>,private enabled=true){}
  private get(){return this.loaded??=this.factory();}
  async health():Promise<Health>{
    if(!this.enabled)return {available:false,reason:'optional_provider_unconfigured'};
    try{return await (await this.get()).health();}catch{return {available:false,reason:'optional_runtime_unavailable'};}
  }
  async preflight(task:HarnessTask,ctx:ExecutionContext){const adapter=await this.get();await adapter.preflight?.(task,ctx);}
  async execute(task:HarnessTask,ctx:ExecutionContext):Promise<AdapterResult>{
    if(!this.enabled)throw new RouterError('adapter_unavailable','Optional specialist is unconfigured');
    return (await this.get()).execute(task,ctx);
  }
  async cancel(runId:string){if(this.loaded)await (await this.loaded).cancel?.(runId);}
  async close(){if(this.loaded)try{await (await this.loaded).close?.();}catch{/* Failed optional imports have no running resources. */}}
}
