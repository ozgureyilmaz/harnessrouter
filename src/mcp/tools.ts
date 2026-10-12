import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {HarnessRouter} from '../runner.js';
import {rawSchemas} from '../domain/schemas.js';
import {redact} from '../observability/trace.js';
export function createMcpServer(router:HarnessRouter) {
  const server=new Server({name:'harnessrouter',version:'0.1.0'},{capabilities:{tools:{}},instructions:'Delegate one task per route_task. For composition, inspect a public website first and pass its structured observations into a separate image task with parentRunId. Only configured routes execute. Paid tasks require authorized budget and allowPaidExecution:true. Inspect get_run after timeout; reuse taskId to reconcile, never duplicate paid jobs. No login, purchases, private accounts or arbitrary code.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'route_task',description:'Select an eligible harness/model through real OpenAI Decisions, execute, verify and return trace/artifacts. Browser: context.url plus allowedDomains. Image: context.creativeOptions. Same taskId is idempotent.',inputSchema:rawSchemas.task,outputSchema:rawSchemas.result,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    {name:'list_harnesses',description:'Read registry, auth presence, current local runtime health, budget and restrictions. No paid request.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'get_run',description:'Read saved result, route decision and trace path by runId.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'cancel_run',description:'Cancel local execution and request provider cancellation when supported; an in-progress paid job may still bill.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}}
  ]}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try {
      const {name,arguments:args}=request.params;
      const runId=typeof args?.runId==='string'?args.runId:'';
      const data=name==='route_task'?await router.routeTask(args,extra.signal):name==='list_harnesses'?await router.listHarnesses():name==='get_run'?await router.getRun(runId):name==='cancel_run'?router.cancel(runId):(()=>{throw new Error('Unknown tool');})();
      const safe=redact(data) as Record<string,unknown>;
      return {content:[{type:'text' as const,text:JSON.stringify(safe)}],structuredContent:safe,isError:name==='route_task'&&!['completed','defer_to_host'].includes(String(safe.status))};
    }catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify(redact({code:(error as {code?:string}).code??'mcp_error',message:error instanceof Error?error.message:'Tool failed'}))}]};}
  });return server;
}
