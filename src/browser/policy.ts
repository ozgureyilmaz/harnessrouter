import { domainToASCII } from 'node:url';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';

type DnsLookup = typeof dnsLookup;

export class BrowserPolicyError extends Error {
  readonly code = 'BROWSER_POLICY_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'BrowserPolicyError';
  }
}

function normalizeHostname(hostname: string): string {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return domainToASCII(unbracketed.replace(/\.$/, '')).toLowerCase();
}

function validateDomain(domain: string): string {
  if (typeof domain !== 'string' || domain.trim() !== domain || domain.length === 0) {
    throw new BrowserPolicyError('Allowed domains must be bare hostnames.');
  }
  if (/[/:?#@*\\\s]/.test(domain) || domain.includes('..')) {
    throw new BrowserPolicyError('Allowed domains must be exact hostnames without paths or wildcards.');
  }
  const normalized = normalizeHostname(domain);
  if (!normalized || isIP(normalized)) {
    throw new BrowserPolicyError('Allowed domains must be DNS hostnames, not IP literals.');
  }
  const labels = normalized.split('.');
  if (normalized.length > 253 || labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new BrowserPolicyError('An allowed domain is not a valid DNS hostname.');
  }
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new BrowserPolicyError('Local hostnames cannot be allowlisted.');
  }
  return normalized;
}

export function normalizeAllowedDomains(domains: readonly string[] | undefined): string[] {
  if (!domains?.length) {
    throw new BrowserPolicyError('At least one task-approved public domain is required.');
  }
  return [...new Set(domains.map(validateDomain))];
}

export function intersectAllowedDomains(
  taskDomains: readonly string[] | undefined,
  configuredDomains?: readonly string[],
): string[] {
  if (!taskDomains?.length) return normalizeAllowedDomains(configuredDomains);
  const taskAllowlist = normalizeAllowedDomains(taskDomains);
  if (!configuredDomains?.length) return taskAllowlist;
  const configured = new Set(normalizeAllowedDomains(configuredDomains));
  const effective = taskAllowlist.filter((domain) => configured.has(domain));
  if (effective.length === 0) {
    throw new BrowserPolicyError('Task domains do not overlap the configured browser allowlist.');
  }
  return effective;
}

export function assertAllowedUrl(rawUrl: string, allowedDomains: readonly string[]): URL {
  const allowlist = new Set(normalizeAllowedDomains(allowedDomains));
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
    throw new BrowserPolicyError('A bounded URL is required.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowserPolicyError('The requested URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new BrowserPolicyError('Only HTTPS URLs on the standard port are allowed.');
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isIP(hostname) || !allowlist.has(hostname)) {
    throw new BrowserPolicyError('The requested hostname is outside the task allowlist.');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new BrowserPolicyError('Local hostnames are not allowed.');
  }
  return url;
}

const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIPv4.addSubnet(network, prefix, 'ipv4');
}

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  blockedIPv6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, 'ipv4');
  if (family === 6) {
    return globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  }
  return false;
}

export async function resolvePublicAddresses(
  hostname: string,
  lookup: DnsLookup = dnsLookup,
): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  if (!normalized || isIP(normalized)) {
    throw new BrowserPolicyError('Only allowlisted DNS hostnames can be resolved.');
  }
  const records = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup(normalized, { all: true, order: 'verbatim' }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new BrowserPolicyError('The hostname did not resolve exclusively to public IP addresses.');
  }
  return addresses;
}

export async function validatePublicUrl(
  rawUrl: string,
  allowedDomains: readonly string[],
  lookup?: DnsLookup,
): Promise<URL> {
  const url = assertAllowedUrl(rawUrl, allowedDomains);
  await resolvePublicAddresses(url.hostname, lookup);
  return url;
}
