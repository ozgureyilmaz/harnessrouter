import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

import {RouterError,checkAbort} from '../domain/errors.js';
export function isPublicAddress(ip:string):boolean {
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
  if(isIP(ip)===6){const value=ip.toLowerCase();return !(!value.startsWith('2')&&!value.startsWith('3'))&&!value.startsWith('2001:db8');}
  return false;
}
export async function validatePublicUrl(value:string,allowedDomains?:string[]):Promise<URL> {
  let url:URL;try{url=new URL(value);}catch{throw new RouterError('unsafe_url','Invalid URL');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new RouterError('unsafe_url','Only public HTTPS URLs on standard ports are allowed');
  if(allowedDomains&&!allowedDomains.includes(url.hostname.toLowerCase()))throw new RouterError('domain_denied','URL hostname is outside configured allowlist');
  const records=await lookup(url.hostname,{all:true});
  if(!records.length||records.some(r=>!isPublicAddress(r.address)))throw new RouterError('unsafe_url','Private, local, or reserved addresses are denied');
  return url;
}
export async function assertArtifactPath(path:string,root:string):Promise<string> {
  const canonical=await realpath(path);const base=await realpath(root);
  if(!canonical.startsWith(resolve(base)+sep))throw new RouterError('artifact_path_denied','Artifact must remain under the run directory');return canonical;
}
export async function verifyImage(path:string,options:{expectedRatio?:number;signal?:AbortSignal}={}) {
  if(options.signal)checkAbort(options.signal);
  const buffer=await readFile(path);if(!buffer.length||buffer.length>20*1024*1024)throw new RouterError('artifact_invalid','Image has invalid byte size');
  try {
    const {default:sharp}=await import('sharp');
    const meta=await sharp(buffer,{limitInputPixels:20_000_000}).metadata();
    const mimes:Record<string,string>={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'};
    if(!meta.format||!mimes[meta.format]||!meta.width||!meta.height)throw new Error('Unsupported image');
    await sharp(buffer,{limitInputPixels:20_000_000}).stats();
    if(options.expectedRatio&&Math.abs(meta.width/meta.height-options.expectedRatio)>0.025)throw new Error('Aspect ratio does not match the task');
    return {mimeType:mimes[meta.format],width:meta.width,height:meta.height,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')};
  }catch(e){if(e instanceof RouterError)throw e;throw new RouterError('artifact_invalid',e instanceof Error?e.message:'Image decode failed');}
}
export async function downloadImage(value:string,destination:string,signal:AbortSignal) {
  let url=await validatePublicUrl(value);let response:Response|undefined;
  for(let n=0;n<4;n++){
    checkAbort(signal);response=await fetch(url,{signal,redirect:'manual'});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new RouterError('artifact_invalid','Redirect missing location');url=await validatePublicUrl(new URL(location,url).href);continue;
    }
    break;
  }
  if(!response?.ok||!response.body||!/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type')??''))throw new RouterError('artifact_invalid','Artifact response is not a supported image');
  const length=Number(response.headers.get('content-length'));if(length>20*1024*1024)throw new RouterError('artifact_invalid','Image exceeds size limit');
  const chunks:Uint8Array[]=[];let bytes=0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>20*1024*1024){throw new RouterError('artifact_invalid','Image exceeds size limit');}chunks.push(chunk);}
  await writeFile(destination,Buffer.concat(chunks),{mode:0o600});return verifyImage(destination,{signal});
}
