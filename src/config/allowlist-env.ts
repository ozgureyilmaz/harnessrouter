import {normalizeAllowedDomains} from '../browser/policy.js';

/** Insert one public hostname into a .env file's BROWSER_ALLOWED_DOMAINS line. */
export function addBrowserAllowlistHostname(envText: string, hostname: string): string {
  const normalized = normalizeAllowedDomains([hostname])[0]!;
  const lines = envText.length ? envText.split('\n') : [];
  const index = lines.findIndex(line => /^BROWSER_ALLOWED_DOMAINS=/.test(line));
  if (index === -1) {
    const prefix = envText.length && !envText.endsWith('\n') ? '\n' : '';
    return `${envText}${prefix}BROWSER_ALLOWED_DOMAINS=${normalized}\n`;
  }
  const current = lines[index]!.slice('BROWSER_ALLOWED_DOMAINS='.length);
  const domains = current.split(',').map(domain => domain.trim()).filter(Boolean);
  if (!domains.includes(normalized)) domains.push(normalized);
  lines[index] = `BROWSER_ALLOWED_DOMAINS=${domains.join(',')}`;
  return lines.join('\n');
}
