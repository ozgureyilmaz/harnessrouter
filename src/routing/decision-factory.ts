import type {RouterConfig} from '../config.js';
import type {DecisionSelector,DecisionProvider} from './decision-provider.js';
import {DecisionsClient} from './decisions.js';
import {SystemOneDecisionsClient} from './systemone.js';
export function createDecisionSelector(config:RouterConfig):DecisionSelector{
  const provider:DecisionProvider=config.decisionProvider??'openai';
  if(provider==='openai')return new DecisionsClient({apiKey:config.apiKey,model:config.decisionModel,timeoutMs:config.decisionTimeoutMs,reservationUsd:config.decisionReserveUsd,allowPaid:config.allowPaid,dryRun:config.dryRun});
  return new SystemOneDecisionsClient({provider,model:config.decisionModel,apiKey:provider==='jev'?config.jevApiKey:config.ollayaApiKey,baseUrl:provider==='ollaya'?config.ollayaBaseUrl:undefined,timeoutMs:config.decisionTimeoutMs,allowPaid:config.allowPaid,dryRun:config.dryRun,reservationUsd:config.decisionReserveUsd});
}
