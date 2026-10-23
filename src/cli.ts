import {chmod, mkdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROJECT_ROOT, loadConfig} from './config.js';
import {hostGuidanceDocument} from './mcp/guidance.js';
import {generateHostConfig, type McpHost} from './mcp/host-config.js';
import {runProcess} from './workers/process.js';
import type {WorkerKind, WorkerProfile, WorkerProtocol} from './workers/types.js';

const HOSTS: McpHost[] = ['codex', 'claude-code', 'opencode', 'pi'];
const HELP = `harnessrouter [serve] [--config PATH]\n\nharnessrouter init [--scope user|local] [--selector local|decisions] [--decision-provider openai|jev|ollaya] [--config PATH]\nharnessrouter doctor [--config PATH]\nharnessrouter stats [--sort time|tokens] [--task-type TYPE] [--limit N] [--json] [--config PATH]\nharnessrouter mcp-config --host codex|claude-code|opencode|pi [--config PATH]\n\nserve is the default command. init writes a disabled starter with selector local, so routing needs no decision API key. Pass --selector decisions or --decision-provider to opt into a decision provider. init also writes AGENTS.md in the current directory when that file is absent. An existing AGENTS.md is replaced only after an interactive yes; otherwise the snippet is printed and the file is left unchanged. mcp-config prints a snippet and never edits host configuration.\n`;

export interface CliIO {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** When set, overrides terminal detection for the AGENTS.md overwrite prompt. */
  interactive?: boolean;
  /** Answer the AGENTS.md overwrite prompt. Used by interactive init and tests. */
  confirm?: (question: string) => boolean | Promise<boolean>;
}
interface Parsed {command: 'serve'|'init'|'doctor'|'mcp-config'|'stats'|'help'|'version'; json?:boolean;sortBy?:'time'|'tokens';taskType?:string;limit?:number; configPath?: string; host?: McpHost; scope?: 'user'|'local';selector?:'local'|'decisions';decisionProvider?:'openai'|'jev'|'ollaya'}

function parseArgs(args: string[], cwd: string): Parsed {
  const known = new Set(['serve', 'init', 'doctor', 'mcp-config', 'stats', '--help', '-h', '--version', '-V']);
  let command: Parsed['command'] = 'serve';
  let index = 0;
  if (args[0] && known.has(args[0])) {
    command = args[0] === '--help' || args[0] === '-h' ? 'help' : args[0] === '--version' || args[0] === '-V' ? 'version' : args[0] as Parsed['command'];
    index = 1;
  }
  const parsed: Parsed = {command};
  const seen = new Set<string>();
  while (index < args.length) {
    const flag = args[index++];
    if(command==='stats'&&['--json','--sort','--task-type','--limit'].includes(flag)){
      if(seen.has(flag))throw new Error(`${flag} may be supplied only once`);seen.add(flag);
      if(flag==='--json'){parsed.json=true;continue;}
      const value=args[index++];if(!value||value.startsWith('--'))throw new Error(`${flag} requires a value`);
      if(flag==='--sort'){if(value!=='time'&&value!=='tokens')throw new Error('--sort must be time or tokens');parsed.sortBy=value;}
      else if(flag==='--task-type')parsed.taskType=value;
      else{if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>5000)throw new Error('--limit must be 1..5000');parsed.limit=Number(value);}
    } else if (flag === '--config') {
      if (seen.has(flag)) throw new Error('--config may be supplied only once');
      seen.add(flag);
      const value = args[index++];
      if (!value || value.startsWith('--')) throw new Error('--config requires a path');
      parsed.configPath = resolve(cwd, value);
    } else if (flag === '--host' && command === 'mcp-config') {
      if (seen.has(flag)) throw new Error('--host may be supplied only once');
      seen.add(flag);
      const value = args[index++];
      if (!value || !HOSTS.includes(value as McpHost)) throw new Error('--host must be codex, claude-code, opencode, or pi');
      parsed.host = value as McpHost;
    } else if (flag === '--scope' && command === 'init') {
      if (seen.has(flag)) throw new Error('--scope may be supplied only once');
      seen.add(flag);
      const value = args[index++];
      if (value !== 'user' && value !== 'local') throw new Error('--scope must be user or local');
      parsed.scope = value;
    } else if (flag === '--selector' && command === 'init') {
      if (seen.has(flag)) throw new Error('--selector may be supplied only once');
      seen.add(flag);
      const value = args[index++];
      if (value !== 'local' && value !== 'decisions') throw new Error('--selector must be local or decisions');
      parsed.selector = value;
    } else if (flag === '--decision-provider' && command === 'init') {
      if (seen.has(flag)) throw new Error('--decision-provider may be supplied only once');
      seen.add(flag);
      const value = args[index++];
      if (value !== 'openai' && value !== 'jev' && value !== 'ollaya') throw new Error('--decision-provider must be openai, jev, or ollaya');
      parsed.decisionProvider = value;
    } else if (flag === '--help' || flag === '-h') parsed.command = 'help';
    else if (flag === '--version' || flag === '-V') parsed.command = 'version';
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (parsed.command === 'mcp-config' && !parsed.host) throw new Error('mcp-config requires --host');
  return parsed;
}

function defaultUserConfig(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'harnessrouter', 'config.json');
}
function starterProfiles(): WorkerProfile[] {
  const profiles: Array<[WorkerKind, string]> = [
    ['codex', 'set-this-to-a-model-you-can-use'],
    ['claude-code', 'set-this-to-a-model-you-can-use'],
    ['opencode', 'set-this-to-a-model-you-can-use'],
    ['pi', 'set-this-to-a-model-you-can-use'],
  ];
  return profiles.map(([adapter, model], index): WorkerProfile => ({
    id: `${adapter.replaceAll('-', '-')}-worker-${index + 1}`,
    adapter, enabled: false, allowExecution: false, model,
  }));
}
function starterSettings(selector: 'local'|'decisions', provider: 'openai'|'jev'|'ollaya' = 'openai'): object {
  const gates = {dryRun: true, allowExecution: false, allowPaid: false, workspaceRoots: [], workerProfiles: starterProfiles()};
  if (selector === 'local') return {selector, ...gates};
  return {
    selector, decisionProvider: provider,
    decisionModel: ({openai: 'gpt-6-luna', jev: 'jev-latest', ollaya: 'laya:typed-decisions'} as const)[provider],
    decisionReserveUsd: provider === 'ollaya' ? 0 : 0.01,
    ...gates,
  };
}

function hostGuidanceInteractive(io: CliIO): boolean {
  if (typeof io.interactive === 'boolean') return io.interactive;
  if (io.confirm) return true;
  if (io.stdout || io.stderr) return false;
  return process.stdin.isTTY === true;
}

function promptYes(question: string): Promise<boolean> {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(/^(?:y|yes)$/i.test(answer.trim()));
    });
  });
}

/** Write AGENTS.md when absent. An existing file is replaced only after an interactive yes. */
async function publishHostGuidance(cwd: string, io: CliIO, out: (text: string) => void): Promise<void> {
  const target = join(cwd, 'AGENTS.md');
  const snippet = hostGuidanceDocument();
  try {
    await writeFile(target, snippet, {encoding: 'utf8', mode: 0o644, flag: 'wx'});
    out(`Wrote host guidance: ${target}\n`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (hostGuidanceInteractive(io)) {
    const replace = await (io.confirm ?? promptYes)(`AGENTS.md already exists at ${target}. Overwrite it? [y/N] `);
    if (replace) {
      await writeFile(target, snippet, {encoding: 'utf8', mode: 0o644});
      out(`Replaced host guidance: ${target}\n`);
      return;
    }
    out(`Left existing host guidance unchanged: ${target}\n`);
    return;
  }
  out(`Left existing host guidance unchanged: ${target}\n${snippet}`);
}

function isSupportedNode(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}
function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {version?: string};
  return pkg.version ?? 'unknown';
}
function probeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']) {
    if (env[key]) result[key] = env[key];
  }
  // Callers sometimes pass a partial env (tests, stripped shells). Without PATH,
  // macOS resolves git to the /usr/bin/git xcrun stub, which can sit until timeout.
  if (!result.PATH && process.env.PATH) result.PATH = process.env.PATH;
  result.GIT_TERMINAL_PROMPT = '0';
  result.NO_COLOR = '1';
  return result;
}

async function doctor(configPath: string|undefined, cwd: string, env: NodeJS.ProcessEnv, stdout: (s:string)=>void): Promise<boolean> {
  const config = loadConfig({cwd, configPath, env});
  const safeEnv = probeEnvironment(env);
  let ok = true;
  const report = (label: string, status: 'ok'|'disabled'|'error', detail: string) => {
    stdout(`${status.toUpperCase()} ${label}: ${detail}\n`);
    if (status === 'error') ok = false;
  };
  report('Node.js', isSupportedNode() ? 'ok' : 'error', `${process.versions.node}${isSupportedNode() ? '' : ' (requires >=22.19.0)'}`);
  report('Package', 'ok', `harnessrouter ${packageVersion()}`);
  const liveConfigured=!config.dryRun&&config.allowExecution===true&&(config.decisionProvider==='ollaya'||(config.selector==='decisions'&&config.perTaskUsd>0&&(config.decisionReserveUsd??0)>0));
  const selectorActive=config.selector==='decisions';
  let decisionStatus:'ok'|'disabled'|'error'='ok';
  let decisionDetail=`selector=${config.selector}; provider=${config.decisionProvider}; model=${config.decisionModel}`;
  if(!selectorActive){
    decisionStatus='disabled';
    decisionDetail+='; selector=local, provider configuration unused';
  }else if(config.decisionProvider==='openai'){
    const present=!!config.apiKey;
    decisionDetail+=`; OPENAI_API_KEY=${present?'present':'missing'}; no provider request made`;
    if(!present){decisionStatus=liveConfigured?'error':'disabled';decisionDetail+='; set OPENAI_API_KEY before live Decisions selection';}
    else if(config.dryRun||!config.allowPaid||!config.allowExecution)decisionStatus='disabled';
  }else if(config.decisionProvider==='jev'){
    const present=!!config.jevApiKey;
    decisionDetail+=`; TYPESAFE_API_KEY/JEV_API_KEY=${present?'present':'missing'}; no provider request made`;
    if(!present){decisionStatus=liveConfigured?'error':'disabled';decisionDetail+='; set TYPESAFE_API_KEY (or JEV_API_KEY alias) before live Decisions selection';}
    else if(config.dryRun||!config.allowPaid||!config.allowExecution)decisionStatus='disabled';
  }else{
    decisionDetail+=`; local base URL=${config.ollayaBaseUrl??'not configured'}; optional OLLAYA_API_KEY=${config.ollayaApiKey?'present':'absent'}`;
    if(!config.ollayaBaseUrl){decisionStatus=liveConfigured?'error':'disabled';decisionDetail+='; configure ROUTER_OLLAYA_BASE_URL for selection';}
    else{decisionStatus='ok';decisionDetail+='; configuration valid, no request made, live availability unverified';}
  }
  report('Decision layer',decisionStatus,decisionDetail);
  try {
    const git = await runProcess('git', ['--version'], {cwd: PROJECT_ROOT, env: safeEnv, timeoutMs: 10_000, maxBytes: 8192});
    report('Git', 'ok', git.stdout.trim());
  } catch { report('Git', 'error', 'git --version failed'); }
  const profiles = config.workerProfiles ?? [];
  if (!profiles.length) {report('Worker profiles', 'disabled', 'none configured');return ok;}
  const {getWorkerProtocols} = await import('./workers/catalog.js');
  const protocols = await getWorkerProtocols();
  for (const profile of profiles) {
    if (config.allowExecution !== true) {report(`Worker ${profile.id}`, 'disabled', 'global allowExecution=false; executable was not probed');continue;}
    if (!profile.enabled) {
      report(`Worker ${profile.id}`, 'disabled', `adapter=${profile.adapter}; enabled=${profile.enabled}; allowExecution=${profile.allowExecution}`);
      continue;
    }
    const protocol = protocols.get(profile.adapter);
    if (!protocol) { report(`Worker ${profile.id}`, 'error', `no trusted protocol registered for ${profile.adapter}`); continue; }
    try {
      if (protocol.probe) {
        const health = await protocol.probe(profile);
        if (!health.available) report(`Worker ${profile.id}`, 'error', health.reason ?? 'protocol probe failed');
        else report(`Worker ${profile.id}`, profile.allowExecution ? 'ok' : 'disabled', `adapter=${profile.adapter}; model=${profile.model}; protocol probe passed${profile.allowExecution ? '' : '; allowExecution=false'}`);
      } else {
        const executable = profile.executable ?? ({codex: 'codex', 'claude-code': 'claude', opencode: 'opencode', pi: 'pi'} as const)[profile.adapter];
        const result = await runProcess(executable, protocol.helpArgs ?? ['--help'], {
          cwd: PROJECT_ROOT, env: safeEnv, timeoutMs: 5000, maxBytes: 256 * 1024,
        });
        const missing = protocol.requiredHelpFlags.filter(flag => !result.stdout.includes(flag));
        if (missing.length) report(`Worker ${profile.id}`, 'error', `missing required CLI flags: ${missing.join(', ')}`);
        else report(`Worker ${profile.id}`, profile.allowExecution ? 'ok' : 'disabled', `adapter=${profile.adapter}; model=${profile.model}; required CLI flags present${profile.allowExecution ? '' : '; allowExecution=false'}`);
      }
    } catch (error) {
      report(`Worker ${profile.id}`, 'error', error instanceof Error ? error.message : 'worker help probe failed');
    }
  }
  return ok;
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const cwd = resolve(io.cwd ?? process.cwd());
  const env = io.env ?? process.env;
  const out = io.stdout ?? (text => process.stdout.write(text));
  const err = io.stderr ?? (text => process.stderr.write(text));
  try {
    const parsed = parseArgs(args, cwd);
    if (parsed.command === 'help') { out(HELP); return 0; }
    if (parsed.command === 'version') { out(`${packageVersion()}\n`); return 0; }
    const configPath = parsed.configPath;
    if (parsed.command === 'init') {
      if (parsed.selector === 'local' && parsed.decisionProvider) throw new Error('--decision-provider requires --selector decisions');
      const selector = parsed.selector ?? (parsed.decisionProvider ? 'decisions' : 'local');
      const provider = parsed.decisionProvider ?? 'openai';
      const target = configPath ?? (parsed.scope === 'local' ? join(cwd, '.harnessrouter', 'config.json') : defaultUserConfig(env));
      await mkdir(dirname(target), {recursive: true, mode: 0o700});
      const contents = `${JSON.stringify(starterSettings(selector, provider), null, 2)}\n`;
      await writeFile(target, contents, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await chmod(target, 0o600);
      const selectorNote = selector === 'local'
        ? 'Selector is local: routing uses configured priority and does not call a decision provider or need an API key.\nOpt in with --selector decisions and optionally --decision-provider openai|jev|ollaya.\n'
        : `Selector is decisions with provider ${provider}. A hosted provider needs its API key, paid authorization, and execution permission before live selection.\n`;
      out(`Created disabled starter configuration: ${target}\n${selectorNote}Dry run stays on, execution stays off, and paid calls stay off.\nEdit model names, workspaceRoots, and profile authorization before enabling workers.\n`);
      await publishHostGuidance(cwd, io, out);
      return 0;
    }
    if (parsed.command === 'mcp-config') {
      const path = configPath ?? defaultUserConfig(env);
      out(generateHostConfig(parsed.host!, path));
      return 0;
    }
    if(parsed.command==='stats'){
      const config=loadConfig({cwd,configPath,env});
      const {readPerformanceReport,formatPerformanceReport}=await import('./observability/performance.js');
      const report=await readPerformanceReport(config.artifactsDir,{sortBy:parsed.sortBy,taskType:parsed.taskType,limit:parsed.limit});
      out(parsed.json?JSON.stringify(report,null,2)+'\n':formatPerformanceReport(report));return 0;
    }
    if (parsed.command === 'doctor') return await doctor(configPath, cwd, env, out) ? 0 : 1;
    const {startServer} = await import('./server.js');
    await startServer({cwd, configPath, env});
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : 'harnessrouter command failed'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
