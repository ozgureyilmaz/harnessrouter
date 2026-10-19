import {randomUUID,createHash} from 'node:crypto';
import {chmod,mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {join,relative,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../src/config.js';
import type {BenchmarkRunRecord} from '../src/domain/types.js';
import {normalizeUsageRecord,parseCodexJsonl} from '../src/observability/metering.js';
import {benchmarkDirectory,buildBenchmarkReport,createDesktopBenchmarkRun,gradeBenchmarkRun,importUsageIntoBenchmarkRun,importBenchmarkCosts,importBenchmarkMedia,linkHarnessRuns,saveBenchmarkRun,updateBenchmarkRun,writeBenchmarkSummary} from '../src/observability/benchmark-store.js';
import {validateBenchmarkRun} from '../src/domain/schemas.js';

interface BenchmarkCase {caseId:string;prompt:string}
interface RunOptions {caseFile:string;arm:'codex_direct'|'codex_harnessrouter';model:string;profile?:string;repetitions:number;timeoutMs:number;codexPath:string;serverName:string;reasoningEffort:string;version:string}

function parseFlags(args:string[]):{command:string;values:Map<string,string[]>} {
  const command=args[0];if(!command||!['run','record-desktop','import-usage','import-cost','import-media','link-harness','grade','report'].includes(command))throw new Error('Use one of: run, record-desktop, import-usage, import-cost, import-media, link-harness, grade, report.');
  const values=new Map<string,string[]>();
  for(let i=1;i<args.length;i++){
    const key=args[i]!;if(!key.startsWith('--'))throw new Error(`Unexpected argument: ${key}`);
    const value=args[i+1];if(!value||value.startsWith('--'))throw new Error(`Missing value for ${key}`);
    const list=values.get(key)??[];list.push(value);values.set(key,list);i++;
  }
  return {command,values};
}
function one(values:Map<string,string[]>,key:string,required=false):string|undefined {
  const list=values.get(key);if(!list){if(required)throw new Error(`${key} is required.`);return undefined;}
  if(list.length!==1)throw new Error(`${key} may be provided once.`);return list[0];
}
function many(values:Map<string,string[]>,key:string):string[]{return values.get(key)??[];}
function ensureOnly(values:Map<string,string[]>,allowed:string[]):void {for(const key of values.keys())if(!allowed.includes(key))throw new Error(`Unknown argument: ${key}`);}
function safeCase(value:unknown):BenchmarkCase {
  if(!isRecord(value)||typeof value.caseId!=='string'||!/^[a-z0-9][a-z0-9_-]{0,119}$/.test(value.caseId)||typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>30_000)throw new Error('Case file must contain a safe caseId and a non-empty prompt under 30000 characters.');
  return {caseId:value.caseId,prompt:value.prompt};
}

async function runOne(options:RunOptions,task:BenchmarkCase,repetition:number,artifactsDir:string):Promise<BenchmarkRunRecord> {
  const benchmarkRunId=randomUUID();const directory=benchmarkDirectory(artifactsDir);const outputDirectory=join(directory,'outputs');
  await mkdir(outputDirectory,{recursive:true,mode:0o700});
  const outputPath=join(outputDirectory,`${benchmarkRunId}.txt`);
  await writeFile(outputPath,'',{flag:'wx',mode:0o600});
  const evidenceDirectory=join(directory,'evidence');await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
  const evidencePath=join(evidenceDirectory,`${benchmarkRunId}-codex.jsonl`);
  const startedAt=new Date().toISOString();const start=performance.now();
  const initial:BenchmarkRunRecord={schemaVersion:'1.0',benchmarkRunId,caseId:task.caseId,arm:options.arm,repetition,promptHash:createHash('sha256').update(task.prompt).digest('hex'),startedAt,timestampSource:'run_time',status:'interrupted',outcome:'ungraded',codex:{model:options.model,modelSource:'requested',version:options.version,reasoningEffort:options.reasoningEffort,evidencePath:relative(artifactsDir,evidencePath),...(options.profile?{profile:options.profile}:{}),outputPath:relative(artifactsDir,outputPath)},harnessRunIds:[],usage:[normalizeUsageRecord({provider:'openai-codex',model:options.model,source:'codex_cli_jsonl',measurement:'unavailable',details:'Codex CLI has not returned usage counters for this run.'})],costComponents:[]};
  await saveBenchmarkRun(artifactsDir,initial);
  const args=['exec','--json','--ephemeral','--sandbox','read-only','--model',options.model];
  if(options.profile)args.push('--profile',options.profile);
  args.push('--config',`model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,'--config',`mcp_servers.${options.serverName}.enabled=${options.arm==='codex_harnessrouter'}`);
  if(options.arm==='codex_harnessrouter')args.push('--config',`mcp_servers.${options.serverName}.required=true`);
  args.push('--output-last-message',outputPath,'-');
  const parsed=await executeCodex(options.codexPath,args,task.prompt,options.timeoutMs,options.model,evidencePath,options.serverName,outputPath);
  const durationMs=performance.now()-start;
  await chmod(outputPath,0o600).catch(()=>{});
  const incompleteExecution=parsed.timedOut||parsed.interrupted||parsed.spawnFailed||parsed.exitCode!==0||parsed.result.failedTurns>0;
  const usage={...parsed.result.usage,evidenceRef:relative(artifactsDir,evidencePath),...(incompleteExecution&&parsed.result.usage.completeness==='complete'?{completeness:'partial' as const}:{})};
  const record:BenchmarkRunRecord={
    ...initial,
    status:parsed.timedOut?'timed_out':parsed.interrupted?'interrupted':parsed.spawnFailed||parsed.exitCode!==0||parsed.result.completedTurns===0||parsed.result.failedTurns>0?'failed':'completed',
    durationMs,
    codex:{...initial.codex,...(parsed.result.threadId?{threadId:parsed.result.threadId}:{}),...(parsed.exitCode===null?{}:{exitCode:parsed.exitCode})},
    harnessRunIds:parsed.result.harnessRunIds,
    usage:[usage],
    costComponents:[],
    ...(parsed.errorCode?{errorCode:parsed.errorCode}:{}),
  };
  await updateBenchmarkRun(artifactsDir,record);
  return record;
}

async function executeCodex(command:string,args:string[],prompt:string,timeoutMs:number,model:string,evidencePath:string,serverName:string,outputPath:string):Promise<{result:ReturnType<typeof parseCodexJsonl>;exitCode:number|null;timedOut:boolean;interrupted:boolean;spawnFailed:boolean;errorCode?:string}> {
  await writeFile(evidencePath,'',{mode:0o600,flag:'wx'});
  return new Promise(resolvePromise=>{
    const codexEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(key)));
    const child=spawn(command,args,{cwd:loadConfig().root,env:codexEnv,stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
    const lines=createInterface({input:child.stdout});const sanitizedEvents:string[]=[];
    let evidenceWrites=Promise.resolve();let writeFailed=false;let diagnosticCode:string|undefined;let lastAgentMessage:string|undefined;
    lines.on('line',line=>{
      try{const event=JSON.parse(line);if(event.type==='item.completed'&&event.item?.type==='agent_message'){
        const text=typeof event.item.text==='string'?event.item.text:typeof event.item.content==='string'?event.item.content:undefined;
        if(text)lastAgentMessage=text.slice(0,1_000_000);
      }}catch{/* Malformed events have no reviewable answer. */}
      const projection=projectCodexEvent(line,serverName);
      if(projection){const event=JSON.parse(projection);if(typeof event.diagnosticCode==='string')diagnosticCode=event.diagnosticCode;sanitizedEvents.push(projection);evidenceWrites=evidenceWrites.then(()=>writeFile(evidencePath,projection+'\n',{flag:'a',mode:0o600})).catch(()=>{writeFailed=true;stop();});}
    });
    let timedOut=false;let interrupted=false;let spawnFailed=false;let errorCode:string|undefined;let settled=false;let killTimer:NodeJS.Timeout|undefined;
    const signalGroup=(signal:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
    const stop=()=>{signalGroup('SIGTERM');killTimer=setTimeout(()=>signalGroup('SIGKILL'),1_000);killTimer.unref();};
    const onInterrupt=()=>{interrupted=true;stop();};process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);timer.unref();
    child.once('error',()=>{spawnFailed=true;errorCode='codex_spawn_failed';});
    child.once('close',async code=>{
      if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);lines.close();
      const result=parseCodexJsonl(sanitizedEvents.join('\n'),model,serverName);
      await evidenceWrites;
      // Some CLI versions return an empty last-message file. Preserve the completed
      // agent message in the private review output, never in usage-only evidence.
      if(lastAgentMessage&&!(await readFile(outputPath,'utf8')).trim())await writeFile(outputPath,lastAgentMessage,{mode:0o600});
      if(writeFailed){spawnFailed=true;errorCode='metering_evidence_write_failed';}
      else if(timedOut)errorCode='codex_timeout';else if(interrupted)errorCode='codex_interrupted';else if(code!==0)errorCode=spawnFailed?'codex_spawn_failed':diagnosticCode??`codex_exit_${code??'unknown'}`;else if(result.failedTurns>0)errorCode=diagnosticCode??'codex_turn_failed';else if(result.completedTurns===0)errorCode=diagnosticCode??'codex_no_completed_turn';
      resolvePromise({result,exitCode:code,timedOut,interrupted,spawnFailed,...(errorCode?{errorCode}:{})});
    });
    child.stdin?.on('error',()=>{});child.stdin?.end(prompt);
  });
}

function projectCodexEvent(line:string,serverName:string):string|undefined {
  try {
    const parsed:unknown=JSON.parse(line);if(!isRecord(parsed))return undefined;
    const type=parsed.type;
    if(type==='thread.started')return JSON.stringify({type,thread_id:parsed.thread_id});
    const diagnosticCode=classifyCodexError(parsed);
    if(type==='error')return JSON.stringify({type,...(diagnosticCode?{diagnosticCode}:{})});
    if(type==='turn.completed'||type==='turn.failed'){
      const info=isRecord(parsed.info)&&isRecord(parsed.info.last_token_usage)?{last_token_usage:parsed.info.last_token_usage}:undefined;
      return JSON.stringify({type,usage:parsed.usage,...(info?{info}:{}),...(diagnosticCode?{diagnosticCode}:{})});
    }
    if(type==='item.completed'&&isRecord(parsed.item)&&parsed.item.type==='mcp_tool_call'&&parsed.item.tool==='route_task'&&parsed.item.server===serverName){
      const item=parsed.item;
      const envelope=isRecord(item.result)?item.result:{};
      const result=isRecord(envelope.structured_content)?envelope.structured_content:isRecord(envelope.structuredContent)?envelope.structuredContent:undefined;
      if(!result||typeof result.runId!=='string')return JSON.stringify({type,item:{type:'mcp_tool_call',server:serverName,tool:'route_task'}});
      const safeResult={runId:result.runId,selectedHarnessId:result.selectedHarnessId,selectedModelId:result.selectedModelId,
        usage:Array.isArray(result.usage)?result.usage:[],costComponents:Array.isArray(result.costComponents)?result.costComponents:[],
        artifacts:Array.isArray(result.artifacts)?result.artifacts.filter(isRecord).map(artifact=>({type:artifact.type,providerRequestId:artifact.providerRequestId})):[]};
      return JSON.stringify({type,item:{type:'mcp_tool_call',server:serverName,tool:'route_task',result:{structured_content:safeResult}}});
    }
    // Operational event kinds explain missing outputs without persisting arguments,
    // commands, tool payloads, or message text.
    if(typeof type==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(type)){
      const item=isRecord(parsed.item)?parsed.item:{};
      const messageShape=item.type==='agent_message'?{fields:Object.keys(item).filter(key=>/^[a-zA-Z0-9._-]{1,80}$/.test(key)),textLength:typeof item.text==='string'?item.text.length:null,contentType:typeof item.content}:undefined;
      return JSON.stringify({type,...(typeof item.type==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(item.type)?{item:{type:item.type,...(messageShape?{messageShape}:{})}}:{})});
    }
  }catch{/* Ignore non-JSON and malformed Codex output without persisting it. */}
  return undefined;
}

/** Retain an allowlisted category only; never persist raw error messages or credentials. */
function classifyCodexError(event:Record<string,unknown>):string|undefined {
  const error=isRecord(event.error)?event.error:{};
  const message=[event.message,error.message,error.code].filter(value=>typeof value==='string').join(' ').slice(0,10000).toLowerCase();
  if(/model.*(not supported|unsupported|not available|does not exist)|unsupported.*model|model_not_found/.test(message))return 'codex_model_unavailable';
  if(/rate.limit|usage.limit|quota|too many requests/.test(message))return 'codex_rate_limit';
  if(/unauthorized|authentication|invalid.*(token|key)|login|401/.test(message))return 'codex_authentication';
  if(/mcp.*(fail|initializ|connect)|required.*server/.test(message))return 'codex_mcp_startup';
  if(/stream disconnect|error sending request|connection|network|dns|timed out|timeout/.test(message))return 'codex_transport';
  return undefined;
}

async function runCommand(values:Map<string,string[]>):Promise<void> {
  ensureOnly(values,['--case','--arm','--model','--profile','--repetitions','--timeout-ms','--codex','--server-name','--reasoning-effort']);
  const caseFile=resolve(one(values,'--case',true)!);const task=safeCase(JSON.parse(await readFile(caseFile,'utf8')));
  const arm=one(values,'--arm',true);if(arm!=='codex_direct'&&arm!=='codex_harnessrouter')throw new Error('--arm must be codex_direct or codex_harnessrouter.');
  const model=one(values,'--model',true)!;if(!/^[a-zA-Z0-9._:-]{1,100}$/.test(model))throw new Error('--model contains unsupported characters.');
  const profile=one(values,'--profile');if(profile&&!/^[a-zA-Z0-9_-]{1,80}$/.test(profile))throw new Error('--profile contains unsupported characters.');
  const repetitions=Number(one(values,'--repetitions')??'1');if(!Number.isInteger(repetitions)||repetitions<1||repetitions>20)throw new Error('--repetitions must be an integer from 1 to 20.');
  const timeoutMs=Number(one(values,'--timeout-ms')??'180000');if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('--timeout-ms must be from 1000 to 600000.');
  const codexPath=one(values,'--codex')??'codex';
  const serverName=one(values,'--server-name')??'harnessrouter';if(!/^[a-zA-Z0-9_-]{1,80}$/.test(serverName))throw new Error('--server-name contains unsupported characters.');
  const reasoningEffort=one(values,'--reasoning-effort')??'high';if(!['low','medium','high','xhigh'].includes(reasoningEffort))throw new Error('--reasoning-effort must be low, medium, high or xhigh.');
  const versionResult=await promisify(execFile)(codexPath,['--version'],{timeout:5000,maxBuffer:4096}).catch(()=>({stdout:'unavailable'}));
  const version=versionResult.stdout.trim().match(/^codex-cli [\w.-]+$/)?.[0]??'unavailable';
  for(let repetition=1;repetition<=repetitions;repetition++){
    const record=await runOne({caseFile,arm,model,profile,repetitions,timeoutMs,codexPath,serverName,version,reasoningEffort},task,repetition,benchmarkArtifactsDir);
    console.log(JSON.stringify({benchmarkRunId:record.benchmarkRunId,arm:record.arm,repetition:record.repetition,status:record.status,usage:record.usage[0],harnessRunIds:record.harnessRunIds}));
    if(record.status!=='completed')break;
  }
}

async function importUsageCommand(values:Map<string,string[]>):Promise<void> {
  ensureOnly(values,['--run-id','--file','--harness-run-id']);
  const runId=one(values,'--run-id',true)!;
  const payload:unknown=JSON.parse(await readFile(resolve(one(values,'--file',true)!), 'utf8'));
  if(!isRecord(payload)||typeof payload.sourceLabel!=='string')throw new Error('Usage import JSON must contain sourceLabel, provider/model, and token counters.');
  const usage=normalizeUsageRecord({provider:typeof payload.provider==='string'?payload.provider:'openai-codex',model:typeof payload.model==='string'?payload.model:undefined,source:'codex_app_import',measurement:'manual_import',counters:payload.counters,details:`Manually imported from ${payload.sourceLabel.slice(0,200)}`});
  const updated=await importUsageIntoBenchmarkRun(benchmarkArtifactsDir,runId,usage);
  if(many(values,'--harness-run-id').length)await linkHarnessRuns(benchmarkArtifactsDir,runId,many(values,'--harness-run-id'));
  console.log(JSON.stringify({benchmarkRunId:updated.benchmarkRunId,usage:updated.usage.at(-1),harnessRunIds:[...new Set([...updated.harnessRunIds,...many(values,'--harness-run-id')])]}));
}

async function recordDesktopCommand(values:Map<string,string[]>):Promise<void> {
  ensureOnly(values,['--case','--arm','--repetition','--model','--profile','--thread-id','--duration-ms','--status','--usage-file','--harness-run-id']);
  const task=safeCase(JSON.parse(await readFile(resolve(one(values,'--case',true)!), 'utf8')));
  const arm=one(values,'--arm',true);if(arm!=='codex_direct'&&arm!=='codex_harnessrouter')throw new Error('--arm must be codex_direct or codex_harnessrouter.');
  const model=one(values,'--model',true)!;const profile=one(values,'--profile');const threadId=one(values,'--thread-id');
  const repetition=Number(one(values,'--repetition',true));if(!Number.isInteger(repetition)||repetition<1||repetition>1000)throw new Error('--repetition must be a positive integer.');
  const durationText=one(values,'--duration-ms');const durationMs=durationText===undefined?undefined:Number(durationText);
  if(durationMs!==undefined&&(!Number.isFinite(durationMs)||durationMs<0))throw new Error('--duration-ms must be finite and nonnegative.');
  const status=one(values,'--status')??'completed';if(!['completed','failed','timed_out','interrupted'].includes(status))throw new Error('--status must be completed, failed, timed_out, or interrupted.');
  const usagePayload:unknown=JSON.parse(await readFile(resolve(one(values,'--usage-file',true)!), 'utf8'));
  if(!isRecord(usagePayload)||typeof usagePayload.sourceLabel!=='string'||!isRecord(usagePayload.counters))throw new Error('Usage JSON must contain sourceLabel and counters.');
  const record=await createDesktopBenchmarkRun(benchmarkArtifactsDir,{caseId:task.caseId,arm,repetition,prompt:task.prompt,model,profile,threadId,durationMs,status:status as BenchmarkRunRecord['status'],sourceLabel:usagePayload.sourceLabel,counters:usagePayload.counters,harnessRunIds:many(values,'--harness-run-id')});
  console.log(JSON.stringify({benchmarkRunId:record.benchmarkRunId,caseId:record.caseId,arm:record.arm,repetition:record.repetition,promptHash:record.promptHash,usage:record.usage[0],harnessRunIds:record.harnessRunIds}));
}

async function gradeCommand(values:Map<string,string[]>):Promise<void> {
  ensureOnly(values,['--run-id','--outcome','--evidence']);
  const outcome=one(values,'--outcome',true);if(outcome!=='verified_success'&&outcome!=='verified_failure')throw new Error('--outcome must be verified_success or verified_failure.');
  const record=await gradeBenchmarkRun(benchmarkArtifactsDir,one(values,'--run-id',true)!,outcome,one(values,'--evidence',true)!);
  console.log(JSON.stringify({benchmarkRunId:record.benchmarkRunId,outcome:record.outcome,gradeEvidence:record.gradeEvidence,gradedAt:record.gradedAt}));
}

async function reportCommand(values:Map<string,string[]>):Promise<void> {
  ensureOnly(values,[]);const config=loadConfig();const report=await buildBenchmarkReport(benchmarkArtifactsDir);const path=await writeBenchmarkSummary(benchmarkArtifactsDir,report);
  console.log(JSON.stringify({summaryPath:relative(config.root,path),report},null,2));
}

const {command,values}=parseFlags(process.argv.slice(2));
const benchmarkArtifactsDir=resolve(one(values,'--artifacts-dir')??loadConfig().artifactsDir);
values.delete('--artifacts-dir');
if(command==='run')await runCommand(values);
else if(command==='record-desktop')await recordDesktopCommand(values);
else if(command==='import-usage')await importUsageCommand(values);
else if(command==='import-media'){
  ensureOnly(values,['--run-id','--file','--evidence']);
  const media=JSON.parse(await readFile(resolve(one(values,'--file',true)!),'utf8'));
  if(!Array.isArray(media))throw new Error('Media import JSON must contain an array of image/video unit records.');
  const updated=await importBenchmarkMedia(benchmarkArtifactsDir,one(values,'--run-id',true)!,media,one(values,'--evidence',true)!);
  console.log(JSON.stringify({benchmarkRunId:updated.benchmarkRunId,mediaOutputs:updated.mediaOutputs,mediaImportHistory:updated.mediaImportHistory}));
}
else if(command==='import-cost'){
  ensureOnly(values,['--run-id','--file']);
  const components=JSON.parse(await readFile(resolve(one(values,'--file',true)!),'utf8'));
  if(!Array.isArray(components))throw new Error('Cost import JSON must be an array of provider/model cost components.');
  const runId=one(values,'--run-id',true)!;
  validateBenchmarkRun({schemaVersion:'1.0',benchmarkRunId:runId,caseId:'cost-import-validation',arm:'codex_direct',repetition:1,promptHash:'0'.repeat(64),startedAt:new Date().toISOString(),status:'completed',outcome:'ungraded',harnessRunIds:[],usage:[],costComponents:components});
  const updated=await importBenchmarkCosts(benchmarkArtifactsDir,runId,components);
  console.log(JSON.stringify({benchmarkRunId:updated.benchmarkRunId,importedCostComponents:components.length}));
}
else if(command==='link-harness'){
  ensureOnly(values,['--run-id','--harness-run-id']);const record=await linkHarnessRuns(benchmarkArtifactsDir,one(values,'--run-id',true)!,many(values,'--harness-run-id'));
  console.log(JSON.stringify({benchmarkRunId:record.benchmarkRunId,harnessRunIds:record.harnessRunIds}));
}else if(command==='grade')await gradeCommand(values);
else await reportCommand(values);

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
