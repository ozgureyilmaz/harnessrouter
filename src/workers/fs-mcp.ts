import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {realpath,lstat,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {protectedWorkspacePath} from '../workspace/snapshot.js';
import {RouterError} from '../domain/errors.js';
const protectedParts={test:protectedWorkspacePath};
const workspaceToolNames=['list_files','read_file','write_file'] as const;
export function workspaceToolsFor(mode:'read-only'|'patch',enabled?:readonly string[]):string[]{
  const defaults=mode==='patch'?[...workspaceToolNames]:['list_files','read_file'];
  if(!enabled)return defaults;
  return defaults.filter(name=>enabled.includes(name));
}
export async function workspaceTool(rootInput:string,mode:'read-only'|'patch',name:string,args:Record<string,unknown>,enabledTools?:readonly string[]):Promise<unknown>{
  const root=await realpath(rootInput);const input=args.path??'.';
  if(typeof input!=='string'||isAbsolute(input)||input.includes('\\')||/^[a-z]:/i.test(input)||input.includes('\0')||input.split(/[\\/]/).some(part=>part==='..'||protectedParts.test(part)))throw new RouterError('workspace_path_denied','Only project-relative non-sensitive paths are allowed');
  const path=resolve(root,input);if(relative(root,path).startsWith('..'+sep)||isAbsolute(relative(root,path)))throw new RouterError('workspace_path_denied','Path is outside the snapshot');
  // Check every existing component; no symlink traversal even when the final target is new.
  let current=root;
  for(const part of relative(root,path).split(sep).filter(Boolean)){
    current=resolve(current,part);
    try{if((await lstat(current)).isSymbolicLink())throw new RouterError('workspace_path_denied','Symbolic links are not allowed');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
  }
  if(enabledTools&&!workspaceToolsFor(mode,enabledTools).includes(name))throw new RouterError(name==='write_file'&&mode!=='patch'?'workspace_read_only_violation':'tool_not_enabled',name==='write_file'&&mode!=='patch'?'This worker has read-only access':'This route profile did not enable that workspace tool');
  if(name==='list_files')return (await readdir(path,{withFileTypes:true})).filter(entry=>!entry.isSymbolicLink()&&!protectedParts.test(entry.name)).slice(0,1000).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':'file'}));
  if(name==='read_file'){
    const stat=await lstat(path);if(!stat.isFile()||stat.size>1024*1024)throw new RouterError('workspace_file_limit','Only regular files up to 1 MiB may be read');
    return {path:input,content:await readFile(path,'utf8')};
  }
  if(name==='write_file'){
    if(mode!=='patch')throw new RouterError('workspace_read_only_violation','This worker has read-only access');
    if(typeof args.content!=='string'||Buffer.byteLength(args.content)>1024*1024)throw new RouterError('workspace_file_limit','Content must be a string up to 1 MiB');
    await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,args.content,{mode:0o600});return {path:input,written:true};
  }
  throw new RouterError('unknown_tool','Unknown workspace tool');
}
export async function serveWorkspace(root:string,mode:'read-only'|'patch',enabledTools?:readonly string[]){
  const names=new Set(workspaceToolsFor(mode,enabledTools));
  const server=new Server({name:'harnessrouter_workspace',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    {name:'list_files',description:'List regular project entries; use a relative path.',inputSchema:{type:'object',properties:{path:{type:'string'}},additionalProperties:false}},
    {name:'read_file',description:'Read a regular project file using a relative path.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
    ...(mode==='patch'?[{name:'write_file',description:'Write a project file in the isolated snapshot. Changes return as a patch.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}]:[])
  ].filter(tool=>names.has(tool.name))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{try{const result=await workspaceTool(root,mode,request.params.name,request.params.arguments??{},enabledTools);return {content:[{type:'text',text:JSON.stringify(result)}]};}catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:error instanceof RouterError?error.code:'workspace_tool_failed'})}]};}});
  await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,mode,tools]=process.argv.slice(2);if(!root||!['read-only','patch'].includes(mode))throw new Error('Expected snapshot path and mode');
  const enabled=tools?.split(',').filter(Boolean);
  if(enabled?.some(name=>!workspaceToolNames.includes(name as typeof workspaceToolNames[number])))throw new Error('Unknown workspace tool');
  await serveWorkspace(root,mode as 'read-only'|'patch',enabled);
}
