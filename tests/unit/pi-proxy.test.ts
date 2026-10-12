import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createAllowlistProxy } from '../../src/browser/allowlist-proxy.js';

async function connectStatus(
  port: number,
  authority: string,
  authorization?: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Proxy response timed out.'));
    }, 2_000);
    const finish = (status: number) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => {
      const authHeader = authorization ? `Proxy-Authorization: ${authorization}\r\n` : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authHeader}\r\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      const status = /^HTTP\/1\.1 (\d+)/.exec(response)?.[1];
      if (status) finish(Number(status));
    });
  });
}

test('authenticated CONNECT proxy challenges unauthenticated clients and denies outside hosts', async (t) => {
  const proxy = await createAllowlistProxy(['example.com']);
  t.after(() => proxy.close());
  const port = Number(new URL(proxy.server).port);
  const authorization = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;

  assert.equal(await connectStatus(port, 'example.com:443'), 407);
  assert.equal(await connectStatus(port, 'evil.example:443', authorization), 403);
  assert.equal(await connectStatus(port, '127.0.0.1:443', authorization), 403);
});
