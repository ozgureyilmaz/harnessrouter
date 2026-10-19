import type {EligibleRoute} from '../registry/eligibility.js';
import type {WorkerProfile} from '../workers/types.js';
/** Stable configured priorities; ties return control instead of guessing. */
export function selectLocal(candidates:readonly EligibleRoute[],profiles:readonly WorkerProfile[]=[]):EligibleRoute|undefined{
  const specialists=candidates.filter(c=>c.harness.kind!=='host_defer');
  const pool=specialists.length?specialists:candidates;
  if(pool.length===1)return pool[0];
  const ranked=pool.map(candidate=>({candidate,priority:profiles.find(p=>p.id===candidate.harness.id)?.priority??0})).sort((a,b)=>b.priority-a.priority);
  return ranked.length&&ranked[0].priority>(ranked[1]?.priority??-1)?ranked[0].candidate:undefined;
}
