import type {EligibleRoute} from '../registry/eligibility.js';
import type {RoutePerformance} from '../observability/performance.js';
import {localCandidatePool, localRoutePriority} from './local.js';
import type {RouteProfile} from '../workers/route-profile.js';
import type {WorkerProfile} from '../workers/types.js';

export interface SelectionObservation {
  routeId: string;
  taskType: string;
  attempts: number;
  completed: number;
  medianTotalMs: number | null;
  medianTotalTokens: number | null;
}
export interface SelectionFeedback {
  enabled: true;
  applied: boolean;
  reason: 'priority_decided' | 'observation_winner' | 'no_observation_winner' | 'observation_tie' | 'observations_unavailable' | 'hosted_selector_unchanged';
  taskType: string;
  selectedRouteId?: string;
  compared: SelectionObservation[];
}

/** Same task-type key the performance report stores: sorted unique requirements. */
export function taskTypeFor(requirements: readonly string[]): string {
  const values = [...new Set(requirements.map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
  return values.join('+') || 'unknown';
}

export function selectionObservations(routes: readonly RoutePerformance[]): SelectionObservation[] {
  return routes.map((row) => ({routeId: row.routeId, taskType: row.taskType, attempts: row.attempts, completed: row.completed, medianTotalMs: row.timing.medianTotalMs, medianTotalTokens: row.usage.medianTotalTokens}));
}

/** Bounded local history. A read failure is undefined so a priority winner can still be used. */
export async function loadSelectionObservations(root: string): Promise<SelectionObservation[] | undefined> {
  try {
    const {readPerformanceReport} = await import('../observability/performance.js');
    return selectionObservations((await readPerformanceReport(root, {limit: 250})).routes);
  } catch {
    return undefined;
  }
}

function aggregate(routeId: string, taskType: string, rows: readonly SelectionObservation[]): SelectionObservation {
  const matched = rows.filter((row) => row.routeId === routeId && row.taskType === taskType);
  if (!matched.length) return {routeId, taskType, attempts: 0, completed: 0, medianTotalMs: null, medianTotalTokens: null};
  const primary = [...matched].sort((a, b) => b.attempts - a.attempts)[0]!;
  return {routeId, taskType, attempts: matched.reduce((sum, row) => sum + row.attempts, 0), completed: matched.reduce((sum, row) => sum + row.completed, 0), medianTotalMs: primary.medianTotalMs, medianTotalTokens: primary.medianTotalTokens};
}

function uniqueLowest(routes: readonly EligibleRoute[], compared: readonly SelectionObservation[], key: 'medianTotalMs' | 'medianTotalTokens'): EligibleRoute[] | undefined {
  const rows = routes.map((route) => ({route, value: compared.find((row) => row.routeId === route.route.id)?.[key] ?? null}));
  if (rows.some((row) => row.value === null)) return undefined;
  const best = Math.min(...rows.map((row) => row.value as number));
  return rows.filter((row) => row.value === best).map((row) => row.route);
}

/**
 * Local priority still ranks first. Observations can separate only an equal top priority,
 * and only when every tied route has saved attempts for this task type.
 */
export function applySelectionFeedback(candidates: readonly EligibleRoute[], profiles: readonly WorkerProfile[], observations: readonly SelectionObservation[] | undefined, taskType: string, routeProfiles: readonly RouteProfile[] = []): {route?: EligibleRoute; feedback: SelectionFeedback} {
  const pool = localCandidatePool(candidates);
  const ranked = pool.map((candidate) => ({candidate, priority: localRoutePriority(candidate, profiles, routeProfiles)})).sort((a, b) => b.priority - a.priority || a.candidate.route.id.localeCompare(b.candidate.route.id));
  const top = ranked[0]?.priority ?? 0;
  const tied = ranked.filter((item) => item.priority === top).map((item) => item.candidate);
  const compared = tied.map((candidate) => aggregate(candidate.route.id, taskType, observations ?? []));
  const feedback = (reason: SelectionFeedback['reason'], applied: boolean, route?: EligibleRoute): SelectionFeedback => ({enabled: true, applied, reason, taskType, ...(route ? {selectedRouteId: route.route.id} : {}), compared});
  if (tied.length <= 1) return {route: tied[0], feedback: feedback('priority_decided', false, tied[0])};
  if (observations === undefined) return {feedback: feedback('observations_unavailable', false)};
  if (compared.some((row) => row.attempts < 1)) return {feedback: feedback('no_observation_winner', false)};
  const rate = (route: EligibleRoute) => {const row = compared.find((item) => item.routeId === route.route.id)!; return row.completed / row.attempts;};
  const bestRate = Math.max(...tied.map(rate));
  if (bestRate <= 0) return {feedback: feedback('observation_tie', false)};
  let winners = tied.filter((route) => rate(route) === bestRate);
  if (winners.length > 1) {
    const faster = uniqueLowest(winners, compared, 'medianTotalMs');
    if (faster && faster.length < winners.length) winners = faster;
  }
  if (winners.length > 1) {
    const cheaper = uniqueLowest(winners, compared, 'medianTotalTokens');
    if (cheaper && cheaper.length < winners.length) winners = cheaper;
  }
  if (winners.length === 1) return {route: winners[0], feedback: feedback('observation_winner', true, winners[0])};
  return {feedback: feedback('observation_tie', false)};
}
