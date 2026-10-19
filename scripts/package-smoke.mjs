import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=await mkdtemp(join(tmpdir(),'harnessrouter-package-'));
function command(args,cwd){const result=spawnSync('npm',args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024,shell:false,timeout:120000});if(result.error?.code==='ETIMEDOUT')throw new Error(`npm ${args[0]} exceeded the 120s package-check limit`);if(result.status!==0)throw new Error(`npm ${args[0]} failed: ${(result.stderr??'').slice(-1500)}`);return result.stdout;}
let client,transport;
try{
  const args=process.argv.slice(2);
  let archivePath;let offline=false;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--offline'&&!offline){offline=true;continue;}
    if(args[index]==='--tarball'&&!archivePath&&args[index+1]&&!args[index+1].startsWith('--')){archivePath=resolve(args[++index]);continue;}
    throw new Error('Usage: package-smoke.mjs [--tarball PATH] [--offline]');
  }
  const archive=archivePath??join(root,JSON.parse(command(['pack','--ignore-scripts','--json','--pack-destination',root],process.cwd()))[0].filename);
  const project=join(root,'consumer');await mkdir(project);await writeFile(join(project,'package.json'),JSON.stringify({name:'harnessrouter-clean-consumer',version:'1.0.0',private:true}));
  // npm ci caches dependency tarballs but does not guarantee cached package metadata.
  // A fresh CI runner may need the public registry; strict offline mode is explicit.
  command(['install',offline?'--offline':'--prefer-offline','--ignore-scripts','--omit=optional','--no-audit','--no-fund',archive],project);
  const entry=join(project,'node_modules','harnessrouter','dist','index.js');
  const version=spawnSync(process.execPath,[entry,'--version'],{cwd:project,encoding:'utf8'});
  const expected=JSON.parse(await readFile('package.json','utf8')).version;
  const installedBin=spawnSync(join(project,'node_modules','.bin','harnessrouter'),['--version'],{cwd:project,encoding:'utf8'});
  if(installedBin.status!==0||installedBin.stdout.trim()!==expected)throw new Error('Installed npm executable smoke failed');
  if(version.status!==0||version.stdout.trim()!==expected)throw new Error('Installed package version/exit code smoke failed');
  const bad=spawnSync(process.execPath,[entry,'--unknown-option'],{cwd:project,encoding:'utf8'});
  if(bad.status===0||bad.stdout)throw new Error('Invalid CLI invocation must fail on stderr with nonzero exit');
  const config=join(root,'config.json');await writeFile(config,JSON.stringify({dryRun:true,allowExecution:false,workerProfiles:[],workspaceRoots:[],artifactsDir:join(root,'runs')}));
  // No provider credentials or native account locations are inherited into the smoke server.
  const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'home','config'),XDG_STATE_HOME:join(root,'home','state'),HARNESSROUTER_TRUST_PROJECT_CONFIG:'false',ROUTER_ALLOW_PAID_RUNS:'false',ROUTER_DRY_RUN:'true'};
  await mkdir(env.HOME,{recursive:true});
  for(const provider of ['openai','jev','ollaya']){
    const starter=join(root,`${provider}.json`);
    const initialized=spawnSync(process.execPath,[entry,'init','--decision-provider',provider,'--config',starter],{cwd:project,encoding:'utf8',env});
    if(initialized.status!==0)throw new Error(`Installed ${provider} initialization failed`);
    const settings=JSON.parse(await readFile(starter,'utf8'));
    if(settings.selector!=='decisions'||settings.decisionProvider!==provider||settings.dryRun!==true||settings.allowPaid!==false||settings.allowExecution!==false)throw new Error(`Installed ${provider} starter configuration mismatch`);
  }
  client=new Client({name:'harnessrouter-package-smoke',version:'1.0.0'},{capabilities:{}});
  transport=new StdioClientTransport({command:process.execPath,args:[entry,'--config',config],cwd:project,env,stderr:'pipe'});
  await client.connect(transport);
  const listing=await client.listTools();
  if(JSON.stringify(listing.tools.map(t=>t.name).sort())!==JSON.stringify(['route_task','list_harnesses','get_run','cancel_run'].sort()))throw new Error('Installed package tool contract mismatch');
  const status=await client.callTool({name:'list_harnesses',arguments:{}});
  if(status.isError)throw new Error('Missing optional dependencies prevented registry inspection');
  if(status.structuredContent?.decisionLayer?.provider!=='openai'||status.structuredContent?.decisionLayer?.enabled!==true)throw new Error('Installed default decision provider is not active OpenAI');
  const history=await client.callTool({name:'list_harnesses',arguments:{includePerformance:true}});
  if(history.isError||history.structuredContent?.performance?.scope!=='router_and_worker_only')throw new Error('Installed MCP performance report smoke failed');
  const stats=spawnSync(process.execPath,[entry,'stats','--config',config,'--json'],{cwd:project,encoding:'utf8',env});
  if(stats.status!==0||JSON.parse(stats.stdout).scope!=='router_and_worker_only')throw new Error('Installed stats CLI smoke failed');
  const answer=await client.callTool({name:'route_task',arguments:{schemaVersion:'1.1',taskId:'offline-package-smoke',prompt:'Handle this on the host',requirements:['coding'],acceptanceCriteria:[]}});
  if(answer.isError||answer.structuredContent?.status!=='defer_to_host')throw new Error('Installed package keyless host-defer smoke failed');
  console.log(`Clean ${offline?'offline ':''}tarball install passed without optional dependencies: three provider starters, active OpenAI default, CLI exit codes, MCP handshake, four tools, registry, performance reports, and keyless host defer. No provider calls.`);
}finally{await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
