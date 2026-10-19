import type {HarnessManifest, Route} from '../domain/types.js';
import type {WorkerProfile} from './types.js';
import {RouterError} from '../domain/errors.js';
/** Profiles are trusted local configuration; manifests never carry executable code. */
export function workerManifests(profiles:readonly WorkerProfile[]):HarnessManifest[]{
  return profiles.map(profile=>({
    id:profile.id,kind:'external_agent_runtime',transport:'subprocess',
    enabled:profile.enabled&&profile.allowExecution,
    permissions:['workspace_read','isolated_workspace_write'],
    capabilities:['coding','review','text','workspace.read','workspace.patch'],
    default_timeout_ms:profile.timeoutMs??120000,
    routes:[{id:`${profile.id}:configured`,description:`${profile.adapter} independent worker (${profile.model}); isolated snapshot and reviewable patch.`,agent_model_profile:profile.model,modalities:['text','patch'],eligible_requirements:['coding','review','text'],price_status:'unknown'}],
  }));
}
export function validateWorkerManifest(manifest:HarnessManifest,profile:WorkerProfile):void{
  const expected=workerManifests([profile])[0];
  if(manifest.kind!==expected.kind||manifest.transport!==expected.transport||manifest.routes.length!==1)throw new RouterError('registry_unsupported','Worker manifest does not match its registered adapter');
  const route:Route=manifest.routes[0];
  if(route.id!==`${profile.id}:configured`||route.agent_model_profile!==profile.model||route.generation_model_id!=null||route.price_status!=='unknown'||route.price_usd!=null||route.fallback_requirements!==undefined)throw new RouterError('registry_unsupported','Worker route/model must match its configured profile');
  if(manifest.capabilities.some(x=>!expected.capabilities.includes(x))||manifest.permissions.some(x=>!expected.permissions.includes(x))||route.modalities.some(x=>!expected.routes[0].modalities.includes(x))||route.eligible_requirements.some(x=>!expected.routes[0].eligible_requirements.includes(x)))throw new RouterError('registry_unsupported','Worker manifest exceeds implemented capabilities');
}
