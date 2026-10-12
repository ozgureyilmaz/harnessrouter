import {RouterError} from '../domain/errors.js';
import type {HarnessManifest, Route} from '../domain/types.js';
import type {DecisionChoice} from './decisions.js';
import type {EligibleRoute} from '../registry/eligibility.js';

/** Convert only policy-filtered registry entries into Decisions `choice` values. */
export function buildDecisionChoices(eligible: readonly EligibleRoute[]): DecisionChoice[] {
  const seen = new Set<string>();
  return eligible.map(({harness, route}) => {
    if (!route.id || seen.has(route.id)) throw new RouterError('registry_invalid', 'Eligible route IDs must be unique and non-empty');
    seen.add(route.id);
    return {value: route.id, description: routeDescription(harness, route)};
  });
}

/** Resolve a selected route only from the same filtered set sent to Decisions. */
export function findEligibleRoute(routeId: string, eligible: readonly EligibleRoute[]): EligibleRoute {
  const match = eligible.find(candidate => candidate.route.id === routeId);
  if (!match) throw new RouterError('invalid_decision', 'Selected route was not in the eligible registry');
  return match;
}

function routeDescription(harness: HarnessManifest, route: Route): string {
  const profile = route.generation_model_id ?? route.agent_model_profile;
  const profileLabel = profile ? `; profile=${profile}` : '';
  return `${harness.id}: ${route.description}${profileLabel}; modalities=${route.modalities.join(',')}; requirements=${route.eligible_requirements.join(',')}`;
}
