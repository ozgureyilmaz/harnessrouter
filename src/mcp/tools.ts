import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {HarnessRouter} from '../runner.js';
import {rawSchemas} from '../domain/schemas.js';
import {VERSION} from '../version.js';
import {redact} from '../observability/trace.js';
import {MCP_INSTRUCTIONS,MCP_TOOL_DESCRIPTIONS} from './guidance.js';
export function createMcpServer(router:HarnessRouter) {
  const server=new Server({name:'harnessrouter',version:VERSION},{capabilities:{tools:{}},instructions:MCP_INSTRUCTIONS});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'route_task',description:MCP_TOOL_DESCRIPTIONS.route_task,inputSchema:rawSchemas.task,outputSchema:rawSchemas.result,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    {name:'list_harnesses',description:MCP_TOOL_DESCRIPTIONS.list_harnesses,inputSchema:{type:'object',properties:{includePerformance:{type:'boolean',default:false}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'get_run',description:MCP_TOOL_DESCRIPTIONS.get_run,inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'cancel_run',description:MCP_TOOL_DESCRIPTIONS.cancel_run,inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}}
  ]}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try {
      const {name,arguments:args}=request.params;
      const runId=typeof args?.runId==='string'?args.runId:'';
      const data=name==='route_task'?await router.routeTask(args,extra.signal):name==='list_harnesses'?await router.listHarnesses({includePerformance:args?.includePerformance===true}):name==='get_run'?await router.getRun(runId):name==='cancel_run'?router.cancel(runId):(()=>{throw new Error('Unknown tool');})();
      const safe=redact(data) as Record<string,unknown>;
      return {content:[{type:'text' as const,text:JSON.stringify(safe)}],structuredContent:safe,isError:name==='route_task'&&!['completed','defer_to_host'].includes(String(safe.status))};
    }catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify(redact({code:(error as {code?:string}).code??'mcp_error',message:error instanceof Error?error.message:'Tool failed'}))}]};}
  });return server;
}
