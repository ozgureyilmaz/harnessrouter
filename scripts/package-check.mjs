import {spawnSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
if(pkg.private||pkg.name!=='harnessrouter'||pkg.license!=='MIT'||pkg.bin?.harnessrouter!=='dist/index.js')throw new Error('Package publication metadata is incomplete');
if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkg.version))throw new Error('version must be strict MAJOR.MINOR.PATCH with no prerelease');
if(pkg.engines?.node!=='>=22.19.0')throw new Error('engines.node must stay >=22.19.0');
if(pkg.main!=='dist/api.js'||pkg.types!=='dist/api.d.ts'||pkg.exports?.['.']?.types!=='./dist/api.d.ts'||pkg.exports?.['.']?.import!=='./dist/api.js')throw new Error('main, types, and exports must point at dist/api');
if(pkg.publishConfig?.access!=='public'||pkg.publishConfig?.provenance!==true)throw new Error('publishConfig must request public access and provenance');
if(!Array.isArray(pkg.files)||!pkg.files.includes('CHANGELOG.md')||!pkg.files.includes('dist/'))throw new Error('files allowlist must ship dist and CHANGELOG.md');
const result=spawnSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,shell:false});
if(result.status!==0)throw new Error('npm pack inspection failed');
const [pack]=JSON.parse(result.stdout);
const files=pack.files.map(file=>file.path);
for(const path of files){
  if(!/^(?:dist\/|contracts\/|docs\/|config\/(?:harness-registry\.yaml|\.env\.example)$|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|CONTRIBUTING\.md$|CODE_OF_CONDUCT\.md$|SECURITY\.md$)/.test(path))throw new Error(`Unexpected package file: ${path}`);
  if(path.endsWith('.pdf')||path.endsWith('.npmignore'))throw new Error(`Unexpected package file: ${path}`);
  if(/(?:^|\/)(?:node_modules|artifacts|\.git|\.env|auth\.json|credentials)(?:\/|$)/.test(path))throw new Error(`Private runtime data in package: ${path}`);
  if(path.startsWith('dist/')&&!/\.(?:js|d\.ts)$/.test(path))throw new Error(`Unexpected compiled file: ${path}`);
}
for(const path of ['dist/index.js','dist/api.js','dist/api.d.ts','dist/workers/fs-mcp.js','dist/workers/pi-bootstrap.js','dist/routing/decision-factory.js','dist/routing/systemone.js','docs/DECISION_PROVIDERS.md','contracts/task.schema.json','contracts/result.schema.json','config/harness-registry.yaml','LICENSE','CHANGELOG.md','README.md'])if(!files.includes(path)||!existsSync(path))throw new Error(`Required package file missing: ${path}`);
if(!readFileSync('dist/index.js','utf8').startsWith('#!/usr/bin/env node'))throw new Error('CLI executable needs a shebang');
console.log(`Offline package inspection passed: ${files.length} allowlisted files; ${(pack.unpackedSize/1024).toFixed(0)} KiB unpacked. No provider calls.`);
