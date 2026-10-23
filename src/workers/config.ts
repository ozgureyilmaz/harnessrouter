import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {WorkerProfile} from './types.js';
import {RouterError} from '../domain/errors.js';
const schema = z.array(z.object({
  id:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  adapter:z.enum(['codex','claude-code','opencode','pi']),
  enabled:z.boolean().default(false), allowExecution:z.boolean().default(false),
  model:z.string().min(1).max(100).regex(/^[^\s\x00-\x1f]+$/),
  executable:z.string().min(1).refine(x=>!/[\x00-\x1f]/.test(x)&&(isAbsolute(x)||/^[a-zA-Z0-9_.-]+$/.test(x))),
  priority:z.number().int().min(0).max(1000).optional(),
  timeoutMs:z.number().int().min(1000).max(300000).optional(),
  allowedModels:z.array(z.string().min(1).max(100)).max(16).optional(),
  allowUnknownCost:z.boolean().optional(),provider:z.string().min(1).max(100).optional(),
  codexTransport:z.enum(['cli','app-server']).optional(),
}).partial({executable:true}).strict()).max(32);
export function parseWorkerProfiles(value:unknown):WorkerProfile[]{
  const parsed=schema.safeParse(value??[]);
  if(!parsed.success)throw new RouterError('invalid_config','Invalid worker profiles: '+parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));
  const ids=new Set<string>();
  const profiles:WorkerProfile[]=[];
  for(const profile of parsed.data){
    if(['native','pi-browser','fal-creative'].includes(profile.id)||ids.has(profile.id))throw new RouterError('invalid_config','Worker profile IDs must be unique and cannot replace specialist adapters');
    if(profile.codexTransport&&profile.adapter!=='codex')throw new RouterError('invalid_config','codexTransport is only valid on a Codex worker');
    ids.add(profile.id);
    const {codexTransport,...rest}=profile;
    profiles.push(codexTransport==='app-server'?{...rest,codexTransport}:rest);
  }
  return profiles;
}
