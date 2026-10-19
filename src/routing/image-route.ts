import {RouterError} from '../domain/errors.js';
import type {HarnessTask} from '../domain/types.js';
import type {EligibleRoute} from '../registry/eligibility.js';

export type ImageRoutePreference = 'auto' | 'fast' | 'quality';

const FAST_ROUTE = 'fal-creative:image-fast';
const QUALITY_ROUTE = 'fal-creative:image-quality';

export function parseImageRoutePreference(value: string | undefined): ImageRoutePreference {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'fast' || normalized === 'quality') return normalized;
  throw new RouterError('invalid_config', 'ROUTER_IMAGE_ROUTE must be auto, fast, or quality');
}

/** Pin one fal image profile so a daily image task does not pay for a Decisions call. */
export function applyStaticImageRoute(
  eligible: readonly EligibleRoute[],
  preference: ImageRoutePreference,
  task: HarnessTask,
): {eligible: EligibleRoute[]; excluded: {id: string; reason: string}[]} {
  const explicit = explicitCreativeQuality(task);
  if (!isImageTask(task) || (preference === 'auto' && explicit !== 'fast' && explicit !== 'high')) return {eligible: [...eligible], excluded: []};
  const pinned = explicit === 'fast' ? FAST_ROUTE : explicit === 'high' ? QUALITY_ROUTE : preference === 'fast' ? FAST_ROUTE : QUALITY_ROUTE;
  if (!eligible.some(candidate => candidate.route.id === pinned)) return {eligible: [...eligible], excluded: []};

  const excluded: {id: string; reason: string}[] = [];
  let next = eligible.filter(candidate => {
    if (candidate.harness.id !== 'fal-creative' || candidate.route.id === pinned) return true;
    excluded.push({id: candidate.route.id, reason: 'static_image_route'});
    return false;
  });
  const specialists = next.filter(candidate => candidate.harness.kind !== 'host_defer');
  if (specialists.length === 1 && specialists[0]?.route.id === pinned && next.some(candidate => candidate.route.id === 'native:defer')) {
    next = next.filter(candidate => candidate.route.id !== 'native:defer');
    excluded.push({id: 'native:defer', reason: 'static_image_route_skips_host_fallback'});
  }
  return {eligible: next, excluded};
}

function isImageTask(task: HarnessTask): boolean {
  return task.requirements.some(requirement => requirement === 'image' || requirement === 'text_to_image');
}

function explicitCreativeQuality(task: HarnessTask): 'fast' | 'high' | 'balanced' | undefined {
  const options = task.context?.creativeOptions;
  if (!options || typeof options !== 'object') return undefined;
  const quality = (options as {quality?: unknown}).quality;
  return quality === 'fast' || quality === 'high' || quality === 'balanced' ? quality : undefined;
}
