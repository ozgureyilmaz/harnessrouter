import type {EligibleRoute} from '../registry/eligibility.js';
import type {RouteProfile} from '../workers/route-profile.js';
import {routeIdFor} from '../workers/route-profile.js';
import type {WorkerProfile} from '../workers/types.js';
function namedProfileRoute(candidate:EligibleRoute):boolean{
  const prefix=`${candidate.harness.id}:`;
  return candidate.route.id.startsWith(prefix)&&candidate.route.id!==`${candidate.harness.id}:configured`;
}
/** Drop `worker:configured` once that worker has a named route in the pool. */
export function localCandidatePool(candidates:readonly EligibleRoute[]):EligibleRoute[]{
  const specialists=candidates.filter(c=>c.harness.kind!=='host_defer');
  let pool=specialists.length?specialists:[...candidates];
  const profiled=new Set(pool.filter(namedProfileRoute).map(candidate=>candidate.harness.id));
  if(profiled.size)pool=pool.filter(candidate=>!profiled.has(candidate.harness.id)||namedProfileRoute(candidate));
  return pool;
}
/** Named route priority wins for that route. Otherwise the worker priority is used. */
export function localRoutePriority(candidate:EligibleRoute,profiles:readonly WorkerProfile[],routeProfiles:readonly RouteProfile[]):number{
  const named=routeProfiles.find(profile=>routeIdFor(profile)===candidate.route.id);
  return named?.priority??profiles.find(profile=>profile.id===candidate.harness.id)?.priority??0;
}
/** Stable configured priorities; ties return control instead of guessing. */
export function selectLocal(candidates:readonly EligibleRoute[],profiles:readonly WorkerProfile[]=[],routeProfiles:readonly RouteProfile[]=[]):EligibleRoute|undefined{
  const pool=localCandidatePool(candidates);
  if(pool.length===1)return pool[0];
  const ranked=pool.map(candidate=>({candidate,priority:localRoutePriority(candidate,profiles,routeProfiles)})).sort((a,b)=>b.priority-a.priority);
  return ranked.length&&ranked[0].priority>(ranked[1]?.priority??-1)?ranked[0].candidate:undefined;
}
