/** Library entrypoint has no CLI/server startup side effects. */
export {createRouter} from './create-router.js';
export {HarnessRouter} from './runner.js';
export {loadConfig} from './config.js';
export {ProcessWorkerAdapter} from './workers/adapter.js';
export {workerManifests} from './workers/registry.js';
export {getEligibleRoutes} from './registry/eligibility.js';
export {createDecisionSelector} from './routing/decision-factory.js';
export {DecisionsClient} from './routing/decisions.js';
export {SystemOneDecisionsClient} from './routing/systemone.js';
export type {DecisionProvider,DecisionSelector,SystemOneSelectorOptions} from './routing/decision-provider.js';
export type * from './domain/types.js';
export type * from './workers/types.js';
export type * from './workspace/types.js';

export {readPerformanceReport,formatPerformanceReport} from './observability/performance.js';
export type {PerformanceReport,RoutePerformance,PerformanceOptions} from './observability/performance.js';
