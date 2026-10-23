import {spawn} from 'node:child_process';
import {RouterError} from '../domain/errors.js';
export interface ProcessOptions {cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;stdin?:string;timeoutMs?:number;maxBytes?:number;maxRecordBytes?:number;ndjson?:boolean;closeStdinOnEvent?:string;onRecord?:(record:Record<string,unknown>)=>void}
export interface ProcessOutput {stdout:string;records:Record<string,unknown>[];exitCode:number;stderrBytes:number}
/** No shell, bounded output, finite lifetime, process-group cancellation. */
export async function runProcess(command:string,args:readonly string[],options:ProcessOptions):Promise<ProcessOutput>{
  options.signal?.throwIfAborted();
  const maxBytes=options.maxBytes??8*1024*1024;const maxRecord=options.maxRecordBytes??1024*1024;
  return new Promise((resolve,reject)=>{
    const child=spawn(command,[...args],{cwd:options.cwd,env:options.env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true});
    let stdout='';let buffer='';let bytes=0;let stderrBytes=0;let failure:Error|undefined;let escalation:NodeJS.Timeout|undefined;let settled=false;
    const records:Record<string,unknown>[]=[];
    const kill=(signal:NodeJS.Signals)=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
    const groupAlive=()=>{if(!child.pid||process.platform==='win32')return false;try{process.kill(-child.pid,0);return true;}catch{return false;}};
    const stop=(error:Error)=>{if(failure)return;failure=error;kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),500);};
    const timer=setTimeout(()=>stop(new RouterError('worker_timeout','Worker process exceeded its time limit')),options.timeoutMs??5000);
    const abort=()=>stop(new RouterError('cancelled','Worker process cancelled'));
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    const cleanup=()=>{clearTimeout(timer);clearTimeout(escalation);options.signal?.removeEventListener('abort',abort);};
    const consume=(line:string)=>{
      if(!line.trim())return;
      if(Buffer.byteLength(line)>maxRecord)throw new RouterError('worker_output_limit','Worker record exceeds the output limit');
      let record:unknown;try{record=JSON.parse(line);}catch{throw new RouterError('worker_invalid_output','Worker emitted malformed JSON');}
      if(!record||typeof record!=='object'||Array.isArray(record))throw new RouterError('worker_invalid_output','Worker event must be a JSON object');
      records.push(record as Record<string,unknown>);options.onRecord?.(record as Record<string,unknown>);
      const event=record as Record<string,unknown>;
      if(options.closeStdinOnEvent&&(event.type===options.closeStdinOnEvent||(event.type==='response'&&event.success===false)))child.stdin.end();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes){stop(new RouterError('worker_output_limit','Worker output exceeded the configured limit'));return;}
      if(!options.ndjson){stdout+=chunk;return;}
      buffer+=chunk;
      try{let newline:number;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);consume(line);}if(Buffer.byteLength(buffer)>maxRecord)throw new RouterError('worker_output_limit','Worker record exceeds the output limit');}catch(error){stop(error instanceof Error?error:new Error('Worker output failure'));}
    });
    child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>maxBytes)stop(new RouterError('worker_output_limit','Worker stderr exceeded the configured limit'));});
    child.stdin.on('error',()=>{/* Process exit is handled below; never print prompt/error bytes. */});
    child.once('error',()=>{if(settled)return;settled=true;cleanup();reject(new RouterError('worker_spawn_failed','Worker executable could not start'));});
    child.once('close',async(code)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      // A leader can exit while a detached-from-stdio grandchild ignores SIGTERM.
      // Do not clear escalation or release the execution lease until its group is stopped.
      kill('SIGTERM');
      if(groupAlive()){await new Promise(done=>setTimeout(done,500));kill('SIGKILL');await new Promise(done=>setTimeout(done,25));}
      cleanup();
      try{if(options.ndjson&&buffer.trim())consume(buffer);}catch(error){reject(error);return;}
      if(failure){reject(failure);return;}
      const reportedFailure=options.ndjson&&records.some(record=>record.type==='worker_error');
      if(code!==0&&!reportedFailure){reject(new RouterError('worker_exit_failed',`Worker exited unsuccessfully (code ${code??'signal'}); stderr bytes=${stderrBytes}`));return;}
      resolve({stdout,records,exitCode:code??0,stderrBytes});
    });
    if(options.closeStdinOnEvent)child.stdin.write(options.stdin??'');else child.stdin.end(options.stdin??'');
  });
}
/** Native runtimes retain their own authentication stores. No arbitrary parent environment inheritance. */
export function workerEnvironment():NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','SYSTEMROOT','WINDIR','XDG_DATA_HOME','XDG_STATE_HOME','CODEX_HOME','PI_CODING_AGENT_DIR',
    'OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','PI_LOCAL_API_KEY'])if(process.env[key])env[key]=process.env[key];
  env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL='/dev/null';env.GIT_CONFIG_SYSTEM='/dev/null';
  env.GIT_OPTIONAL_LOCKS='0';env.GIT_TERMINAL_PROMPT='0';
  env.NO_COLOR='1';env.HARNESSROUTER_WORKER='1';env.HARNESSROUTER_DELEGATION_DEPTH='1';
  return env;
}
