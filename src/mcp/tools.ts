import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {HarnessRouter,RouteProgress} from '../runner.js';
import {rawSchemas} from '../domain/schemas.js';
import {PROJECT_ROOT} from '../config.js';
import {VERSION} from '../version.js';
import {redact} from '../observability/trace.js';
const getRunSchema=JSON.parse(readFileSync(resolve(PROJECT_ROOT,'contracts/get-run.schema.json'),'utf8')) as Record<string,unknown>;
const getRunInput={...getRunSchema};
delete getRunInput.$schema;
delete getRunInput.$id;
const resultOutput=structuredClone(rawSchemas.result) as Record<string,unknown>;
delete resultOutput.$schema;
// MCP tool schemas require a root type of object. oneOf distinguishes a saved result from the async acknowledgement.
const routeOutputSchema={type:'object',oneOf:[resultOutput,{type:'object',additionalProperties:false,required:['runId','taskId','status'],properties:{runId:{type:'string'},taskId:{type:'string'},status:{const:'running'}}}]};
export function createMcpServer(router:HarnessRouter) {
  const server=new Server({name:'harnessrouter',version:VERSION},{capabilities:{tools:{}},instructions:'Delegate one bounded task per route_task from the current host. Only explicitly enabled local worker profiles may execute repository work, in isolated snapshots returning patches. Workspace roots, permissions and model configuration come from trusted local configuration. A new init file uses local priority and needs no decision API key. OpenAI Decisions, Jev, or loopback Ollaya run only when selector is decisions; a config that omits selector still uses OpenAI Decisions. Eligibility and authorization always precede selection. Use preferredRouteId to choose a worker without a decision call; deterministic local priority ties defer to the host. Subscription-backed workers require allowUnknownCost:true. Pi browser remains public/read-only and fal supports images only. Image generation requires explicit paid approval. A synchronous route_task sends progress notifications when the request has a progressToken. Pass async:true to get a runId immediately; the run keeps going if this request is cancelled. Inspect get_run by runId or taskId. A cancelled or interrupted taskId can be submitted again. A completed or failed taskId returns the saved result. Workers cannot recursively delegate. No login, purchases or private-account actions.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'route_task',description:'Filter authorized reachable routes, use the configured decision provider when selection is needed, execute, verify and return trace/artifacts. Explicit preferredRouteId skips selection. Browser: context.url plus allowedDomains. Image: context.creativeOptions. Set async:true to return {runId, taskId, status:"running"} without waiting. Same taskId is idempotent for completed and failed runs; cancelled and interrupted task ids can run again.',inputSchema:rawSchemas.task,outputSchema:routeOutputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    {name:'list_harnesses',description:'Read the configured decision layer, registry, runtime health, budget and restrictions. Set includePerformance:true for bounded local time/token observations and coverage, excluding host usage. No paid request.',inputSchema:{type:'object',properties:{includePerformance:{type:'boolean',default:false}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'get_run',description:'Read the saved result, route decision and trace path. Pass runId or taskId. taskId resolves to the latest run for that id.',inputSchema:getRunInput,annotations:{readOnlyHint:true}},
    {name:'cancel_run',description:'Cancel local execution and request provider cancellation when supported; an in-progress paid job may still bill. A cancelled taskId may be submitted again.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}}
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
