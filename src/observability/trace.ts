import {appendFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import type {TraceSink} from '../domain/types.js';
export function redact(value: unknown): unknown {
  const secrets = Object.entries(process.env).filter(([key,val])=>val && /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,val])=>val!);
  return JSON.parse(JSON.stringify(value ?? null, (key,item)=>{
    if (/authorization|cookie|api.?key|access.?token|refresh.?token|password|secret/i.test(key)) return '[REDACTED]';
    if (typeof item !== 'string') return item;
    let s = item.replace(/\b(?:sk-[a-zA-Z0-9_-]{10,}|Bearer\s+[^\s"\\]+)\b/g,'[REDACTED]');
    for (const secret of secrets) s = s.split(secret).join('[REDACTED]');
    return s;
  }));
}
export class RunTrace implements TraceSink {
  readonly start = performance.now();
  readonly directory: string;
  readonly path: string;
  private chain = Promise.resolve();
  constructor(root: string, readonly runId: string) {this.directory=join(root,runId);this.path=join(this.directory,'events.jsonl');}
  async event(type: string, data?: unknown): Promise<void> {
    const event={runId:this.runId,type,at:new Date().toISOString(),elapsedMs:performance.now()-this.start,data:redact(data)};
    this.chain=this.chain.then(async()=>{await mkdir(this.directory,{recursive:true,mode:0o700});await appendFile(this.path,JSON.stringify(event)+'\n',{mode:0o600});});
    await this.chain;
  }
  async save(name: string, data: unknown): Promise<string> {
    await this.chain; await mkdir(this.directory,{recursive:true,mode:0o700});
    const target=join(this.directory,name); const temp=target+'.tmp';
    await writeFile(temp,JSON.stringify(redact(data),null,2)+'\n',{mode:0o600}); await rename(temp,target); return target;
  }
}
export function taskFingerprint(prompt:string) {return createHash('sha256').update(prompt).digest('hex');}
