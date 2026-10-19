import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createRouter} from './create-router.js';
import {createMcpServer} from './mcp/tools.js';
import type {ConfigOptions} from './config.js';
export async function startServer(options:ConfigOptions={}){
  const router=await createRouter(options);const server=createMcpServer(router);
  let closed=false;
  async function close(){if(closed)return;closed=true;await router.close();await server.close();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);process.stdin.off('end',ended);}
  const interrupt=()=>void close().catch(()=>{process.exitCode=1;});
  const ended=()=>void close().catch(()=>{process.exitCode=1;});
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);process.stdin.on('end',ended);
  try{await server.connect(new StdioServerTransport());}catch(error){await close();throw error;}
  return {router,server,close};
}
