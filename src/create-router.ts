import {loadConfig,type ConfigOptions} from './config.js';
import {BudgetLedger} from './observability/budget.js';
import {HarnessRouter} from './runner.js';
import {LazyHarnessAdapter} from './harnesses/lazy.js';
import {ProcessWorkerAdapter} from './workers/adapter.js';
import {getWorkerProtocols} from './workers/catalog.js';
export async function createRouter(options:ConfigOptions={}){
  const config=loadConfig(options);const ledger=await BudgetLedger.open(config.artifactsDir,config.sessionUsd);
  try{
    const protocols=await getWorkerProtocols();
    const adapters=[
      new LazyHarnessAdapter('pi-browser',async()=>new (await import('./harnesses/pi-browser.js')).PiBrowserHarness({allowedDomains:config.allowedDomains})),
      new LazyHarnessAdapter('fal-creative',async()=>new (await import('./harnesses/fal-creative.js')).CreativeHarness({apiKey:config.falKey,allowPaid:config.allowPaid,dryRun:config.dryRun,timeoutMs:config.falTaskTimeoutMs}),!!config.falKey),
      ...(config.workerProfiles??[]).map(profile=>new ProcessWorkerAdapter(profile,protocols.get(profile.adapter)!,{roots:config.workspaceRoots??[]},config.artifactsDir,config.allowExecution===true)),
    ];
    return new HarnessRouter(config,adapters,ledger);
  }catch(error){await ledger.close();throw error;}
}
