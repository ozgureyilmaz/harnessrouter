import {loadConfig} from './config.js';
import {BudgetLedger} from './observability/budget.js';
import {HarnessRouter} from './runner.js';
import {CreativeHarness} from './harnesses/fal-creative.js';
import {PiBrowserHarness} from './harnesses/pi-browser.js';
export async function createRouter(){
  const config=loadConfig();const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);
  return new HarnessRouter(config,[new PiBrowserHarness({allowedDomains:config.allowedDomains}),new CreativeHarness({apiKey:config.falKey,allowPaid:config.allowPaid,dryRun:config.dryRun,timeoutMs:config.falTaskTimeoutMs})],ledger);
}
