import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Socket } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolvePublicAddresses, assertAllowedUrl, normalizeAllowedDomains } from './policy.js';

export interface AllowlistProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

function writeResponse(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n\r\n',
  );
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseConnectAuthority(authority: string): { host: string; port: number } {
  if (!authority || /[\s/@?#]/.test(authority)) {
    throw new Error('Invalid CONNECT authority.');
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${authority}`);
  } catch {
    throw new Error('Invalid CONNECT authority.');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid CONNECT authority.');
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (port !== 443) throw new Error('Only standard HTTPS CONNECT is allowed.');
  return { host: parsed.hostname, port };
}

export async function createAllowlistProxy(
  allowedDomains: readonly string[],
): Promise<AllowlistProxy> {
  const allowlist = normalizeAllowedDomains(allowedDomains);
  const username = 'harnessrouter';
  const password = randomBytes(24).toString('base64url');
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sockets = new Set<Duplex>();
  const server: Server = createServer();
  server.on('request', (_request, response) => {
    // The adapter only permits HTTPS CONNECT. Plain HTTP and absolute-form
    // requests are rejected, even if Chrome is configured to use this proxy.
    response.writeHead(403, { 'content-length': '0', connection: 'close' });
    response.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      const auth = request.headers['proxy-authorization'];
      if (!sameSecret(typeof auth === 'string' ? auth : undefined, expectedAuth)) {
        clientSocket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="harnessrouter"\r\n' +
          'Connection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }

      let target: { host: string; port: number };
      try {
        target = parseConnectAuthority(request.url ?? '');
        assertAllowedUrl(`https://${target.host}/`, allowlist);
      } catch {
        writeResponse(clientSocket, 403, 'Forbidden');
        return;
      }

      let addresses: string[];
      try {
        addresses = await resolvePublicAddresses(target.host);
      } catch {
        writeResponse(clientSocket, 403, 'Forbidden');
        return;
      }

      if (clientSocket.destroyed) return;
      const upstream = new Socket();
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      let tunnelReady = false;
      const timeout = setTimeout(() => upstream.destroy(new Error('CONNECT timeout')), 5000);
      timeout.unref();
      upstream.once('connect', () => {
        clearTimeout(timeout);
        tunnelReady = true;
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.once('error', () => {
        clearTimeout(timeout);
        if (tunnelReady) clientSocket.destroy();
        else writeResponse(clientSocket, 502, 'Bad Gateway');
      });
      clientSocket.once('close', () => upstream.destroy());
      upstream.connect({ host: addresses[0], port: target.port });
    })().catch(() => writeResponse(clientSocket, 502, 'Bad Gateway'));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The browser egress proxy did not bind a TCP port.');
  }

  let closed = false;
  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
