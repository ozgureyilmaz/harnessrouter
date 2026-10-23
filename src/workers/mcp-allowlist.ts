import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {RouterError} from '../domain/errors.js';
import type {WorkerMcpServer} from './types.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const SECRET = /\b(?:sk-[a-zA-Z0-9_-]{10,}|Bearer\s+\S+)/;
export const mcpServerSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  command: z.string().min(1).max(300).refine((command) => !/[\x00-\x1f]/.test(command) && (isAbsolute(command) || /^[a-zA-Z0-9_.-]+$/.test(command)), 'MCP server command must be an executable name or absolute path'),
  args: z.array(z.string().min(1).max(200).refine((arg) => !/[\x00-\x1f]/.test(arg), 'MCP server args cannot contain control characters')).max(16).optional(),
}).strict();

function segments(value: string): string[] {
  return value.split(/[/\\]/).filter(Boolean);
}
function base(value: string): string {
  const name = segments(value).at(-1) ?? value;
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}
function launchesHarnessrouter(value: string): boolean {
  return base(value) === 'harnessrouter' || segments(value).includes('harnessrouter');
}

/** Config-time checks that keep the default closed and block recursive delegation. */
export function assertMcpAllowlist(profile: {adapter: string; mcpServers?: readonly WorkerMcpServer[]}): void {
  const servers = profile.mcpServers ?? [];
  if (!servers.length) return;
  if (profile.adapter === 'pi') throw new RouterError('invalid_config', 'Pi does not accept additional MCP servers');
  const names = new Set<string>();
  for (const server of servers) {
    if (server.name === 'harnessrouter' || server.name === 'harnessrouter_workspace') throw new RouterError('invalid_config', 'MCP server name is reserved');
    if (names.has(server.name)) throw new RouterError('invalid_config', 'MCP server names must be unique');
    names.add(server.name);
    if (SHELLS.has(base(server.command).toLowerCase())) throw new RouterError('invalid_config', 'MCP server command cannot be a shell');
    if (launchesHarnessrouter(server.command) || (server.args ?? []).some(launchesHarnessrouter)) throw new RouterError('invalid_config', 'MCP server command cannot launch harnessrouter');
    if (SECRET.test(server.command) || (server.args ?? []).some((arg) => SECRET.test(arg))) throw new RouterError('invalid_config', 'MCP server command or args look like a credential');
  }
}

export function normalizeMcpServers(servers: readonly WorkerMcpServer[] | undefined): WorkerMcpServer[] | undefined {
  if (!servers?.length) return undefined;
  return servers.map((server) => server.args?.length ? {name: server.name, command: server.command, args: [...server.args]} : {name: server.name, command: server.command});
}

/** Codex `-c` value. An empty allowlist stays the closed `mcp_servers={}` literal. */
export function codexMcpServersArg(servers: readonly WorkerMcpServer[] | undefined): string {
  const value: Record<string, {command: string; args?: string[]}> = {};
  for (const server of servers ?? []) value[server.name] = server.args?.length ? {command: server.command, args: [...server.args]} : {command: server.command};
  return `mcp_servers=${JSON.stringify(value)}`;
}

export function claudeAllowedTools(servers: readonly WorkerMcpServer[] | undefined): string[] {
  return ['mcp__harnessrouter_workspace__*', ...(servers ?? []).map((server) => `mcp__${server.name}__*`)];
}

export function claudeMcpServers(workspace: {command: string; args: string[]}, servers: readonly WorkerMcpServer[] | undefined): Record<string, {command: string; args?: string[]}> {
  const mcpServers: Record<string, {command: string; args?: string[]}> = {harnessrouter_workspace: workspace};
  for (const server of servers ?? []) mcpServers[server.name] = server.args?.length ? {command: server.command, args: [...server.args]} : {command: server.command};
  return mcpServers;
}

export function openCodeMcp(servers: readonly WorkerMcpServer[] | undefined): Record<string, {type: 'local'; command: string[]; enabled: true}> {
  const mcp: Record<string, {type: 'local'; command: string[]; enabled: true}> = {};
  for (const server of servers ?? []) mcp[server.name] = {type: 'local', command: [server.command, ...(server.args ?? [])], enabled: true};
  return mcp;
}

/** Names and command basenames only. Arguments stay out of traces. */
export function mcpTrace(servers: readonly WorkerMcpServer[] | undefined): {name: string; command: string}[] {
  return (servers ?? []).map((server) => ({name: server.name, command: base(server.command)}));
}
