import {resolve} from 'node:path';
import {PROJECT_ROOT} from '../config.js';

export type McpHost = 'codex' | 'claude-code' | 'opencode' | 'pi';
const executable = process.execPath;
const entry = resolve(PROJECT_ROOT, 'dist/index.js');
const quoteToml = (value: string): string => JSON.stringify(value);

/** Return a host-native stdio MCP configuration snippet. This function never writes host files. */
export function generateHostConfig(host: McpHost, configPath: string): string {
  const config = resolve(configPath);
  const args = [entry, '--config', config];
  if (host === 'codex') {
    return `[mcp_servers.harnessrouter]\ncommand = ${quoteToml(executable)}\nargs = [${args.map(quoteToml).join(', ')}]\ntool_timeout_sec = 300\n`;
  }
  if (host === 'opencode') {
    return `${JSON.stringify({mcp: {harnessrouter: {type: 'local', command: [executable, ...args], enabled: true, timeout: 300000}}}, null, 2)}\n`;
  }
  const server = {command: executable, args, ...(host === 'pi' ? {timeout: 300} : {})};
  return `${JSON.stringify({mcpServers: {harnessrouter: server}}, null, 2)}\n`;
}
