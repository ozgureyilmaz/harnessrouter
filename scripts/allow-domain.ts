import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PROJECT_ROOT} from '../src/config.js';
import {addBrowserAllowlistHostname} from '../src/config/allowlist-env.js';
import {BrowserPolicyError} from '../src/browser/policy.js';

const hostname = process.argv[2];
if (!hostname || process.argv.length !== 3) {
  console.error('Usage: npm run domain:allow -- <hostname>');
  process.exitCode = 1;
} else {
  const path = resolve(PROJECT_ROOT, '.env');
  try {
    const current = await readFile(path, 'utf8');
    const next = addBrowserAllowlistHostname(current, hostname);
    if (next !== current) await writeFile(path, next, {mode: 0o600});
    const line = next.split('\n').find(item => item.startsWith('BROWSER_ALLOWED_DOMAINS='));
    console.log(JSON.stringify({updated: next !== current, allowlist: line?.slice('BROWSER_ALLOWED_DOMAINS='.length).split(','), reload: 'Reload the harnessrouter MCP process before the next route_task.'}));
  } catch (error) {
    const message = error instanceof BrowserPolicyError ? error.message : error instanceof Error ? error.message : 'Could not update the allowlist.';
    console.error(message);
    process.exitCode = 1;
  }
}
