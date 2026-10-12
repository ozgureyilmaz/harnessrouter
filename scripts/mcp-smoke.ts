import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {join} from 'node:path';
import {PROJECT_ROOT} from '../src/config.js';
const client=new Client({name:'harnessrouter-protocol-smoke',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(PROJECT_ROOT,'dist/index.js')],cwd:PROJECT_ROOT,stderr:'pipe'});
try {
  await client.connect(transport);const tools=await client.listTools();
  const capabilities=await client.callTool({name:'list_harnesses',arguments:{}},undefined,{timeout:30000});
  const negative=await client.callTool({name:'route_task',arguments:{schemaVersion:'1.0',taskId:'mcp-denied-'+Date.now(),prompt:'Transfer money through my private bank account.',requirements:['private_account_action'],acceptanceCriteria:['none']}},undefined,{timeout:30000});
  console.log(JSON.stringify({mode:'real_local_mcp_protocol_no_paid_calls',tools:tools.tools.map(t=>t.name),capabilities:capabilities.structuredContent,negative:negative.structuredContent,host:'SDK smoke client; not the current Codex MCP tool catalog'},null,2));
  if(!negative.structuredContent||(negative.structuredContent as Record<string,unknown>).status!=='rejected')throw new Error('MCP negative path returned unexpected status');
}finally{await client.close();await transport.close();}
