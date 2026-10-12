import test from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { assertAllowedUrl, intersectAllowedDomains, isPublicIpAddress, resolvePublicAddresses, validatePublicUrl } from '../../src/browser/policy.js';

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type FakeLookup = (hostname: string, options: LookupOptions & { all: true }, callback: LookupCallback) => void;

function lookupReturning(addresses: LookupAddress[]): FakeLookup {
  return (_hostname, _options, callback) => callback(null, addresses);
}

test('public URL policy accepts only exact HTTPS allowlisted hostnames', () => {
  assert.equal(assertAllowedUrl('https://example.com/path?x=1', ['example.com']).hostname, 'example.com');
  assert.equal(assertAllowedUrl('https://EXAMPLE.com:443/', ['example.com']).hostname, 'example.com');
  assert.throws(() => assertAllowedUrl('http://example.com/', ['example.com']), /HTTPS/);
  assert.throws(() => assertAllowedUrl('https://sub.example.com/', ['example.com']), /allowlist/);
  assert.throws(() => assertAllowedUrl('https://example.com:8443/', ['example.com']), /standard port/);
  assert.throws(() => assertAllowedUrl('https://user@example.com/', ['example.com']), /standard port/);
  assert.throws(() => assertAllowedUrl('https://127.0.0.1/', ['127.0.0.1']), /DNS hostnames/);
  assert.throws(() => assertAllowedUrl('https://localhost/', ['localhost']), /Local hostnames/);
});

test('domain allowlists require exact bare hostnames and intersect with the configured ceiling', () => {
  assert.deepEqual(intersectAllowedDomains(['www.example.com', 'example.com'], ['example.com']), ['example.com']);
  assert.deepEqual(intersectAllowedDomains(undefined, ['example.com']), ['example.com']);
  assert.throws(() => intersectAllowedDomains(['evil.example'], ['example.com']), /do not overlap/);
  assert.throws(() => intersectAllowedDomains(undefined, undefined), /required/);
  assert.throws(() => intersectAllowedDomains(['*.example.com'], ['example.com']), /exact hostnames/);
  assert.throws(() => intersectAllowedDomains(['https://example.com'], ['example.com']), /exact hostnames/);
});

test('public IP filter rejects local, reserved, and documentation addresses', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('192.168.1.1'), false);
  assert.equal(isPublicIpAddress('127.0.0.1'), false);
  assert.equal(isPublicIpAddress('169.254.1.1'), false);
  assert.equal(isPublicIpAddress('203.0.113.1'), false);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpAddress('::1'), false);
  assert.equal(isPublicIpAddress('2001:db8::1'), false);
});

test('DNS policy accepts only public answers and rejects mixed public/private records', async () => {
  const publicLookup = lookupReturning([{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(await resolvePublicAddresses('example.com', publicLookup as never), ['93.184.216.34']);
  await assert.rejects(
    resolvePublicAddresses('example.com', lookupReturning([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.4', family: 4 },
    ]) as never),
    /exclusively to public/,
  );
  await assert.rejects(
    validatePublicUrl('https://example.com/', ['example.com'], lookupReturning([{ address: '127.0.0.1', family: 4 }]) as never),
    /exclusively to public/,
  );
});
