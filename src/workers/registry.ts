import type {HarnessManifest} from '../domain/types.js';
import type {WorkerKind, WorkerProfile} from './types.js';
import type {RouteProfile} from './route-profile.js';
import {routeIdFor, routeProfileDescription} from './route-profile.js';
import {RouterError} from '../domain/errors.js';
const routeDescriptions: Record<WorkerKind, string> = {
  codex: 'Implements code changes and returns a patch.',
  'claude-code': 'Read-only review and explanation when the task says not to edit.',
  opencode: 'Edits the repository and returns a patch.',
  pi: 'Local model that reads or edits snapshot files.',
};
/** Profiles are trusted local configuration; manifests never carry executable code. */
export function workerManifests(profiles:readonly WorkerProfile[], routeProfiles:readonly RouteProfile[]=[]):HarnessManifest[]{
  return profiles.map(profile=>{
    const named=routeProfiles.filter(item=>item.harness===profile.id).map(item=>({
      id:routeIdFor(item),description:routeProfileDescription(profile,item),agent_model_profile:item.model??profile.model,
      modalities:item.permissions==='read-only'?['text']:['text','patch'],eligible_requirements:['coding','review','text'],price_status:'unknown' as const,
    }));
    return {
      id:profile.id,kind:'external_agent_runtime' as const,transport:'subprocess' as const,
      enabled:profile.enabled&&profile.allowExecution,
      permissions:['workspace_read','isolated_workspace_write'],
      capabilities:['coding','review','text','workspace.read','workspace.patch'],
      default_timeout_ms:profile.timeoutMs??120000,
      routes:[{id:`${profile.id}:configured`,description:profile.description?.trim()||routeDescriptions[profile.adapter],agent_model_profile:profile.model,modalities:['text','patch'],eligible_requirements:['coding','review','text'],price_status:'unknown' as const},...named],
    };
  });
}
export function validateWorkerManifest(manifest:HarnessManifest,profile:WorkerProfile,routeProfiles:readonly RouteProfile[]=[]):void{
  const expected=workerManifests([profile],routeProfiles.filter(item=>item.harness===profile.id))[0];
  if(manifest.kind!==expected.kind||manifest.transport!==expected.transport||manifest.routes.length!==expected.routes.length)throw new RouterError('registry_unsupported','Worker manifest does not match its registered adapter');
  const expectedRoutes=new Map(expected.routes.map(route=>[route.id,route]));
  for(const route of manifest.routes){
    const match=expectedRoutes.get(route.id);
    const named=route.id!==`${profile.id}:configured`;
    if(!match||route.agent_model_profile!==match.agent_model_profile||route.generation_model_id!=null||route.price_status!=='unknown'||route.price_usd!=null||route.fallback_requirements!==undefined||(named&&route.description!==match.description))throw new RouterError('registry_unsupported','Worker route/model must match its configured profile');
    if(route.modalities.some(item=>!match.modalities.includes(item))||route.eligible_requirements.some(item=>!match.eligible_requirements.includes(item))||(named&&(route.modalities.length!==match.modalities.length||route.eligible_requirements.length!==match.eligible_requirements.length)))throw new RouterError('registry_unsupported','Worker manifest exceeds implemented capabilities');
  }
  if(manifest.capabilities.some(x=>!expected.capabilities.includes(x))||manifest.permissions.some(x=>!expected.permissions.includes(x)))throw new RouterError('registry_unsupported','Worker manifest exceeds implemented capabilities');
}
