import type {EligibleRoute} from '../registry/eligibility.js';
import type {RouteProfile} from '../workers/route-profile.js';
import {routeIdFor} from '../workers/route-profile.js';
import type {WorkerProfile} from '../workers/types.js';
function namedProfileRoute(candidate:EligibleRoute):boolean{
  const prefix=`${candidate.harness.id}:`;
  return candidate.route.id.startsWith(prefix)&&candidate.route.id!==`${candidate.harness.id}:configured`;
}
/** Stable configured priorities; ties return control instead of guessing. */
export function selectLocal(candidates:readonly EligibleRoute[],profiles:readonly WorkerProfile[]=[],routeProfiles:readonly RouteProfile[]=[]):EligibleRoute|undefined{
  const specialists=candidates.filter(c=>c.harness.kind!=='host_defer');
  let pool=specialists.length?specialists:[...candidates];
  const profiled=new Set(pool.filter(namedProfileRoute).map(candidate=>candidate.harness.id));
  if(profiled.size)pool=pool.filter(candidate=>!profiled.has(candidate.harness.id)||namedProfileRoute(candidate));
  if(pool.length===1)return pool[0];
  const ranked=pool.map(candidate=>{
    const named=routeProfiles.find(profile=>routeIdFor(profile)===candidate.route.id);
    const priority=named?.priority??profiles.find(profile=>profile.id===candidate.harness.id)?.priority??0;
    return {candidate,priority};
  }).sort((a,b)=>b.priority-a.priority);
  return ranked.length&&ranked[0].priority>(ranked[1]?.priority??-1)?ranked[0].candidate:undefined;
}
