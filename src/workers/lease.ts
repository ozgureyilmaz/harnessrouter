import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {RouterError} from '../domain/errors.js';
/** An abandoned lease is a reconciliation condition, never permission to re-execute. */
export async function acquireWorkerLease(stateRoot:string,profileId:string,runId:string):Promise<()=>Promise<void>>{
  const directory=join(stateRoot,'worker-leases');await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,createHash('sha256').update(profileId).digest('hex')+'.json');
  const token=randomUUID();
  try{await writeFile(path,JSON.stringify({profileId,runId,pid:process.pid,token,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;throw new RouterError('worker_reconciliation_required','Worker profile has an active or abandoned execution lease; inspect its saved run before retrying');}
  return async()=>{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.token!==token)throw new RouterError('worker_lease_conflict','Worker lease ownership changed');await unlink(path);};
}
