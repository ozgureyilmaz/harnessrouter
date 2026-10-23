import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
import {RouterError} from './domain/errors.js';
import {parseImageRoutePreference} from './routing/image-route.js';
import {parseWorkerProfiles} from './workers/config.js';
import {parseRouteProfiles, type RouteProfile} from './workers/route-profile.js';
import type {WorkerProfile} from './workers/types.js';
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface RouterConfig {
  root:string; apiKey?:string; falKey?:string; allowPaid:boolean; dryRun:boolean;
  perTaskUsd:number; sessionUsd:number; decisionModel:string; decisionTimeoutMs:number;
  decisionProvider?:'openai'|'jev'|'ollaya'; jevApiKey?:string; ollayaApiKey?:string; ollayaBaseUrl?:string; decisionReserveUsd?:number;
  piTaskTimeoutMs:number; falTaskTimeoutMs:number;
  imageRoute:'auto'|'fast'|'quality';allowedDomains:string[];artifactsDir:string;registryPath:string;
  selector?:'local'|'decisions';workerProfiles?:WorkerProfile[];routeProfiles?:RouteProfile[];workspaceRoots?:string[];
  allowExecution?:boolean;configPath?:string;
}
export interface ConfigOptions {cwd?:string;configPath?:string;overrides?:Partial<RouterConfig>;env?:NodeJS.ProcessEnv}
function readSettings(path:string,required=false):Record<string,unknown>{
  if(!existsSync(path)){if(required)throw new RouterError('invalid_config','Explicit configuration file does not exist');return {};}
  try{
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
    const allowed=new Set(['selector','workerProfiles','routeProfiles','workspaceRoots','allowExecution','dryRun','allowPaid','perTaskUsd','sessionUsd','allowedDomains','artifactsDir','registryPath','imageRoute','decisionProvider','decisionModel','decisionTimeoutMs','decisionReserveUsd','ollayaBaseUrl']);
    if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error();
    return value;
  }catch{throw new RouterError('invalid_config','Configuration must be a JSON object with supported settings and no credentials');}
}
/** Precedence: explicit CLI > environment > project > user > defaults. */
export function loadConfig(options:ConfigOptions={}):RouterConfig {
  const cwd=resolve(options.cwd??process.cwd());
  const processEnv=options.env??process.env;
  const userPath=join(processEnv.XDG_CONFIG_HOME??join(homedir(),'.config'),'harnessrouter','config.json');
  const projectPath=join(cwd,'.harnessrouter','config.json');
  const configPath=options.configPath??processEnv.HARNESSROUTER_CONFIG;
  const trustProject=processEnv.HARNESSROUTER_TRUST_PROJECT_CONFIG==='true';
  const settings={...readSettings(userPath),...(trustProject?readSettings(projectPath):{}),...(configPath?readSettings(resolve(cwd,configPath),true):{})};
  // Project dotenv supplies defaults only; a process environment can always disable live work.
  const env:NodeJS.ProcessEnv={...(trustProject&&existsSync(join(cwd,'.env'))?parse(readFileSync(join(cwd,'.env'))):{}),...processEnv};
  for(const key of ['OPENAI_API_KEY','FAL_KEY','TYPESAFE_API_KEY','JEV_API_KEY','OLLAYA_API_KEY'])if(env[key]&&options.env===undefined)process.env[key]=env[key];
  const number=(key:string,fallback:number,setting?:string)=>{
    const value=Number(env[key]??(setting?settings[setting]:undefined)??fallback);
    if(!Number.isFinite(value)||value<0)throw new RouterError('invalid_config',`${key} must be finite and nonnegative`);
    return value;
  };
  const flag=(key:string,setting:string,fallback:boolean)=>{
    const raw=env[key]??settings[setting]??fallback;
    if(typeof raw==='boolean')return raw;
    if(raw==='true')return true;if(raw==='false')return false;
    throw new RouterError('invalid_config',`${key} must be true or false`);
  };
  // Files and processes that omit selector keep OpenAI Decisions. That is fail-closed
  // for older configs. `harnessrouter init` writes "local" explicitly for a keyless first run.
  const selector=env.ROUTER_SELECTOR??settings.selector??'decisions';
  if(selector!=='local'&&selector!=='decisions')throw new RouterError('invalid_config','ROUTER_SELECTOR must be local or decisions');
  const decisionProvider=env.ROUTER_DECISION_PROVIDER??settings.decisionProvider??'openai';
  if(decisionProvider!=='openai'&&decisionProvider!=='jev'&&decisionProvider!=='ollaya')throw new RouterError('invalid_config','ROUTER_DECISION_PROVIDER must be openai, jev, or ollaya');
  const modelDefaults={openai:'gpt-6-luna',jev:'jev-latest',ollaya:'laya:typed-decisions'} as const;
  const decisionModel=env.DECISIONS_MODEL??settings.decisionModel??modelDefaults[decisionProvider];
  if(typeof decisionModel!=='string'||decisionModel.length<1||decisionModel.length>100||/[\x00-\x20\x7f]/.test(decisionModel))throw new RouterError('invalid_config','DECISIONS_MODEL must be 1..100 characters without whitespace or control characters');
  if(decisionProvider==='openai'&&decisionModel!=='gpt-6-luna')throw new RouterError('invalid_config','OpenAI Decisions routing is pinned to gpt-6-luna');
  if(decisionProvider==='jev'&&!/^jev-[A-Za-z0-9._:-]+$/.test(decisionModel))throw new RouterError('invalid_config','TypeSafe Decisions models must use the jev-* model family');
  const decisionTimeoutMs=number('ROUTER_DECISION_TIMEOUT_MS',10000,'decisionTimeoutMs');
  if(!Number.isSafeInteger(decisionTimeoutMs)||decisionTimeoutMs<1||decisionTimeoutMs>2_147_483_647)throw new RouterError('invalid_config','ROUTER_DECISION_TIMEOUT_MS must be a positive 32-bit timer value');
  const perTaskUsd=number('MAX_COST_USD_PER_TASK',.25,'perTaskUsd');
  const decisionReserveUsd=decisionProvider==='ollaya'?0:number('ROUTER_DECISION_RESERVE_USD',.01,'decisionReserveUsd');
  const paidSelectorCanRun=selector==='decisions'&&decisionProvider!=='ollaya'&&perTaskUsd>0;
  if(decisionProvider!=='ollaya'&&(!Number.isFinite(decisionReserveUsd)||decisionReserveUsd<=0))throw new RouterError('invalid_config','ROUTER_DECISION_RESERVE_USD must be positive and finite for hosted decision providers');
  if(paidSelectorCanRun&&decisionReserveUsd>perTaskUsd)throw new RouterError('invalid_config','ROUTER_DECISION_RESERVE_USD must be no greater than MAX_COST_USD_PER_TASK when hosted selection can run');
  const envTypesafe=env.TYPESAFE_API_KEY?.trim()||undefined;
  const envJevAlias=env.JEV_API_KEY?.trim()||undefined;
  if(envTypesafe&&envJevAlias&&envTypesafe!==envJevAlias)throw new RouterError('invalid_config','TYPESAFE_API_KEY and JEV_API_KEY are both set to different values; keep only one TypeSafe credential');
  const typesafeApiKey=envTypesafe??envJevAlias;
  const ollayaRaw=env.ROUTER_OLLAYA_BASE_URL??settings.ollayaBaseUrl;
  if(ollayaRaw!==undefined&&typeof ollayaRaw!=='string')throw new RouterError('invalid_config','ROUTER_OLLAYA_BASE_URL must be a string loopback origin');
  const ollayaBaseUrl=typeof ollayaRaw==='string'&&ollayaRaw.trim()?validateOllayaBaseUrl(ollayaRaw):decisionProvider==='ollaya'?'http://127.0.0.1:11435':undefined;
  const workspaceRoots=settings.workspaceRoots??[];
  if(!Array.isArray(workspaceRoots)||workspaceRoots.some(x=>typeof x!=='string'||!isAbsolute(x)))throw new RouterError('invalid_config','workspaceRoots must contain absolute paths');
  const domains=env.BROWSER_ALLOWED_DOMAINS!==undefined?env.BROWSER_ALLOWED_DOMAINS.split(','):settings.allowedDomains??['example.com'];
  if(!Array.isArray(domains)||domains.some(x=>typeof x!=='string'))throw new RouterError('invalid_config','allowedDomains must be strings');
  const stateRoot=join(processEnv.XDG_STATE_HOME??join(homedir(),'.local','state'),'harnessrouter');
  const config:RouterConfig={
    root:PROJECT_ROOT,apiKey:env.OPENAI_API_KEY||undefined,falKey:env.FAL_KEY||undefined,
    allowPaid:flag('ROUTER_ALLOW_PAID_RUNS','allowPaid',false),dryRun:flag('ROUTER_DRY_RUN','dryRun',true),
    allowExecution:flag('ROUTER_ALLOW_EXECUTION','allowExecution',false),
    perTaskUsd,sessionUsd:number('MAX_COST_USD_PER_SESSION',0,'sessionUsd'),
    decisionProvider,decisionModel,decisionTimeoutMs,decisionReserveUsd,
    jevApiKey:decisionProvider==='jev'?typesafeApiKey:undefined,
    ollayaApiKey:decisionProvider==='ollaya'?(env.OLLAYA_API_KEY?.trim()||undefined):undefined,
    ollayaBaseUrl:decisionProvider==='ollaya'?ollayaBaseUrl:undefined,
    piTaskTimeoutMs:number('PI_TASK_TIMEOUT_MS',120000),falTaskTimeoutMs:number('FAL_TASK_TIMEOUT_MS',180000),
    imageRoute:parseImageRoutePreference(env.ROUTER_IMAGE_ROUTE??String(settings.imageRoute??'auto')),
    allowedDomains:domains.map(x=>x.trim().toLowerCase()).filter(Boolean),
    artifactsDir:resolve(cwd,String(env.ARTIFACTS_DIR??settings.artifactsDir??stateRoot)),
    registryPath:resolve(cwd,String(env.HARNESSROUTER_REGISTRY??settings.registryPath??join(PROJECT_ROOT,'config','harness-registry.yaml'))),
    selector,workerProfiles:parseWorkerProfiles(settings.workerProfiles),routeProfiles:parseRouteProfiles(settings.routeProfiles,parseWorkerProfiles(settings.workerProfiles)),workspaceRoots:workspaceRoots as string[],
    ...(configPath?{configPath:resolve(cwd,configPath)}:{}),
  };
  const merged={...config,...options.overrides};
  if(merged.decisionProvider==='ollaya')merged.decisionReserveUsd=0;
  // Explicit test/application overrides go through the same provider/model constraints as file and env config.
  validateDecisionSettings(merged);
  return merged;
}

function validateDecisionSettings(config:RouterConfig):void{
  if(config.decisionProvider!=='openai'&&config.decisionProvider!=='jev'&&config.decisionProvider!=='ollaya')throw new RouterError('invalid_config','Decision provider must be openai, jev, or ollaya');
  if(typeof config.decisionModel!=='string'||config.decisionModel.length<1||config.decisionModel.length>100||/[\x00-\x20\x7f]/.test(config.decisionModel))throw new RouterError('invalid_config','Decision model must be 1..100 characters without whitespace or control characters');
  if(config.decisionProvider==='openai'&&config.decisionModel!=='gpt-6-luna')throw new RouterError('invalid_config','OpenAI Decisions routing is pinned to gpt-6-luna');
  if(config.decisionProvider==='jev'&&!/^jev-[A-Za-z0-9._:-]+$/.test(config.decisionModel))throw new RouterError('invalid_config','TypeSafe Decisions models must use the jev-* model family');
  if(!Number.isSafeInteger(config.decisionTimeoutMs)||config.decisionTimeoutMs<1||config.decisionTimeoutMs>2_147_483_647)throw new RouterError('invalid_config','Decision timeout must be a positive 32-bit timer value');
  if(config.decisionProvider==='ollaya'){
    if(config.decisionReserveUsd!==0)throw new RouterError('invalid_config','Ollaya does not use a paid decision reservation');
    if(config.ollayaBaseUrl)validateOllayaBaseUrl(config.ollayaBaseUrl);
  }else{
    if(!Number.isFinite(config.decisionReserveUsd)||config.decisionReserveUsd!<=0)throw new RouterError('invalid_config','Hosted decision reserve must be positive and finite');
    if(config.selector!=='local'&&config.perTaskUsd>0&&config.decisionReserveUsd!>config.perTaskUsd)throw new RouterError('invalid_config','Decision reserve must be no greater than the per-task budget when hosted selection can run');
  }
}

export function validateOllayaBaseUrl(value:string):string{
  let url:URL;
  try{url=new URL(value);}catch{throw new RouterError('invalid_config','ROUTER_OLLAYA_BASE_URL must be a valid loopback HTTP(S) origin');}
  const host=url.hostname.toLowerCase();
  const loopback=['localhost','127.0.0.1','[::1]'].includes(host);
  if(!['http:','https:'].includes(url.protocol)||!loopback||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value.includes('?')||value.includes('#')){
    throw new RouterError('invalid_config','ROUTER_OLLAYA_BASE_URL must be a loopback origin without credentials, path, query, or fragment; remote Ollaya origins are unsupported');
  }
  return url.origin;
}
