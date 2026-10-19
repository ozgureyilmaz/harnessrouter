import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {HarnessRouter} from '../runner.js';
import {rawSchemas} from '../domain/schemas.js';
import {VERSION} from '../version.js';
import {redact} from '../observability/trace.js';
export function createMcpServer(router:HarnessRouter) {
  const server=new Server({name:'harnessrouter',version:VERSION},{capabilities:{tools:{}},instructions:'Delegate one bounded task per route_task from the current host. Only explicitly enabled local worker profiles may execute repository work, in isolated snapshots returning patches. Workspace roots, permissions and model configuration come from trusted local configuration. A new init file uses local priority and needs no decision API key. OpenAI Decisions, Jev, or loopback Ollaya run only when selector is decisions; a config that omits selector still uses OpenAI Decisions. Eligibility and authorization always precede selection. Use preferredRouteId to choose a worker without a decision call; deterministic local priority ties defer to the host. Subscription-backed workers require allowUnknownCost:true. Pi browser remains public/read-only and fal supports images only. Image generation requires explicit paid approval. Inspect get_run after timeout and reuse taskId to reconcile; never duplicate an ambiguous paid job. Workers cannot recursively delegate. No login, purchases or private-account actions.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'route_task',description:'Filter authorized reachable routes, use the configured decision provider when selection is needed, execute, verify and return trace/artifacts. Explicit preferredRouteId skips selection. Browser: context.url plus allowedDomains. Image: context.creativeOptions. Same taskId is idempotent.',inputSchema:rawSchemas.task,outputSchema:rawSchemas.result,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    {name:'list_harnesses',description:'Read the configured decision layer, registry, runtime health, budget and restrictions. Set includePerformance:true for bounded local time/token observations and coverage, excluding host usage. No paid request.',inputSchema:{type:'object',properties:{includePerformance:{type:'boolean',default:false}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'get_run',description:'Read saved result, route decision and trace path by runId.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'cancel_run',description:'Cancel local execution and request provider cancellation when supported; an in-progress paid job may still bill.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}}
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
