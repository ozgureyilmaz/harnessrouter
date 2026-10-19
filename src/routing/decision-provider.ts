import type {Budget,HarnessTask,TraceSink} from '../domain/types.js';
import type {DecisionChoice,DecisionResult} from './decisions.js';
export type DecisionProvider = 'openai'|'jev'|'ollaya';
/** Trusted selector configuration, never selected by arbitrary task context. */
export interface DecisionSelector {
  readonly provider:DecisionProvider;
  readonly requiresPaid:boolean;
  readonly reservationUsd:number;
  choose(task:HarnessTask,choices:DecisionChoice[],signal:AbortSignal,trace:TraceSink,budget:Budget):Promise<DecisionResult>;
}
export interface SystemOneSelectorOptions {
  provider:'jev'|'ollaya';model?:string;apiKey?:string;baseUrl?:string;
  timeoutMs?:number;allowPaid:boolean;dryRun:boolean;reservationUsd?:number;
}
