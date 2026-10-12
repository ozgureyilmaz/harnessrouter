import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createRouter} from './create-router.js';
import {createMcpServer} from './mcp/tools.js';
const router=await createRouter();const server=createMcpServer(router);
let closed=false;
async function close(){if(closed)return;closed=true;await router.close();await server.close();}
process.on('SIGINT',()=>void close().then(()=>process.exit(0)));
process.on('SIGTERM',()=>void close().then(()=>process.exit(0)));
process.stdin.on('end',()=>void close());
await server.connect(new StdioServerTransport());
