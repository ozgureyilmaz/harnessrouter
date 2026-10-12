import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PROJECT_ROOT} from '../src/config.js';
const name=process.argv[2];const file=process.argv[3];
if(!['route_task','get_run','list_harnesses','cancel_run'].includes(name))throw new Error('Provide a harnessrouter tool name and optional argument JSON file');
const args=file?JSON.parse(await readFile(file,'utf8')):{};
const client=new Client({name:'codex-stdio-bridge',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(PROJECT_ROOT,'dist/index.js')],cwd:PROJECT_ROOT,stderr:'pipe'});
try{await client.connect(transport);const result=await client.callTool({name,arguments:args},undefined,{timeout:300000});console.log(JSON.stringify({transport:'real_stdio_mcp_sdk_bridge',isError:result.isError??false,data:result.structuredContent??result.content},null,2));if(result.isError)process.exitCode=1;}
finally{await client.close();await transport.close();}
