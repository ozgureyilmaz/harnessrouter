import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
import {loadRegistry} from '../src/registry/loader.js';
import {PiBrowserHarness} from '../src/harnesses/pi-browser.js';
import {CreativeHarness} from '../src/harnesses/fal-creative.js';
const config=loadConfig();const registry=await loadRegistry(config.registryPath);
const exec=promisify(execFile);
const pi=new PiBrowserHarness({allowedDomains:config.allowedDomains});
const fal=new CreativeHarness({apiKey:config.falKey,allowPaid:config.allowPaid,dryRun:config.dryRun});
const [piHealth,falHealth]=await Promise.all([pi.health(),fal.health()]);
let codexVersion='unavailable';try{codexVersion=(await exec('codex',['--version'])).stdout.trim();}catch{}
console.log(JSON.stringify({mode:'nonbillable_preflight',root:config.root,node:process.version,codexVersion,gitInitialized:existsSync(join(config.root,'.git')),registryRoutes:registry.harnesses.flatMap(h=>h.routes.map(r=>r.id)),credentials:{openai:!!config.apiKey,fal:!!config.falKey},policy:{allowPaid:config.allowPaid,dryRun:config.dryRun,sessionCapUsd:config.sessionUsd,perTaskCapUsd:config.perTaskUsd,allowedDomains:config.allowedDomains},pi:piHealth,fal:falHealth,currentSessionMcp:'must verify tool visibility in the active Codex session; this command is not that proof'},null,2));
await pi.close?.();
