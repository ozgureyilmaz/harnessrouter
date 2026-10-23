import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {HarnessRouter,RouteProgress} from '../runner.js';
import {rawSchemas} from '../domain/schemas.js';
import {PROJECT_ROOT} from '../config.js';
import {VERSION} from '../version.js';
import {redact} from '../observability/trace.js';
import {MCP_INSTRUCTIONS,MCP_TOOL_DESCRIPTIONS} from './guidance.js';
const getRunSchema=JSON.parse(readFileSync(resolve(PROJECT_ROOT,'contracts/get-run.schema.json'),'utf8')) as Record<string,unknown>;
const getRunInput={...getRunSchema};
delete getRunInput.$schema;
delete getRunInput.$id;
const resultOutput=structuredClone(rawSchemas.result) as Record<string,unknown>;
delete resultOutput.$schema;
// MCP tool schemas require a root type of object. oneOf distinguishes a saved result from the async acknowledgement.
const routeOutputSchema={type:'object',oneOf:[resultOutput,{type:'object',additionalProperties:false,required:['runId','taskId','status'],properties:{runId:{type:'string'},taskId:{type:'string'},status:{const:'running'}}}]};
export function createMcpServer(router:HarnessRouter) {
  const server=new Server({name:'harnessrouter',version:VERSION},{capabilities:{tools:{}},instructions:MCP_INSTRUCTIONS});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'route_task',description:MCP_TOOL_DESCRIPTIONS.route_task,inputSchema:rawSchemas.task,outputSchema:routeOutputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    {name:'list_harnesses',description:MCP_TOOL_DESCRIPTIONS.list_harnesses,inputSchema:{type:'object',properties:{includePerformance:{type:'boolean',default:false}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'get_run',description:MCP_TOOL_DESCRIPTIONS.get_run,inputSchema:getRunInput,annotations:{readOnlyHint:true}},
    {name:'cancel_run',description:MCP_TOOL_DESCRIPTIONS.cancel_run,inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}}
  ]}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try {
      const {name,arguments:args}=request.params;
      const runId=typeof args?.runId==='string'?args.runId:'';
      const taskId=typeof args?.taskId==='string'?args.taskId:'';
      const progressToken=extra._meta?.progressToken;
      let acceptProgress=progressToken!==undefined;
      const onProgress=acceptProgress?async(update:RouteProgress)=>{
        if(!acceptProgress||progressToken===undefined)return;
        try{await extra.sendNotification({method:'notifications/progress',params:{progressToken,progress:update.elapsedMs,message:`${update.stage} elapsedMs=${update.elapsedMs}`}});}
        catch{acceptProgress=false;}
      }:undefined;
      const data=name==='route_task'?await router.routeTask(args,extra.signal,{onProgress,progressIntervalMs:router.config.progressIntervalMs}):name==='list_harnesses'?await router.listHarnesses({includePerformance:args?.includePerformance===true}):name==='get_run'?await router.getRun(runId?{runId,taskId:taskId||undefined}: {taskId}):name==='cancel_run'?router.cancel(runId):(()=>{throw new Error('Unknown tool');})();
      acceptProgress=false;
      const safe=redact(data) as Record<string,unknown>;
      return {content:[{type:'text' as const,text:JSON.stringify(safe)}],structuredContent:safe,isError:name==='route_task'&&!['completed','defer_to_host','running'].includes(String(safe.status))};
    }catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify(redact({code:(error as {code?:string}).code??'mcp_error',message:error instanceof Error?error.message:'Tool failed'}))}]};}
  });return server;
}
