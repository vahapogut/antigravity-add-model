import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ProxyStartOptions } from '../proxy';
import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as listener from '../proxy/listen';

// Run the production listener and shutdown code with real sockets. The model
// transports are unused: these fixtures simulate a native stream or partial body.
const compiled = ts.transpileModule(fs.readFileSync('src/proxy.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const dependencies: Record<string, unknown> = {
  http,
  https: {},
  fs,
  path,
  'electron-log': { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  './proxy/shared': { startCleanupInterval: vi.fn(), stopCleanupInterval: vi.fn() },
  './proxy/modelUtils': {},
  './proxy/cloudCodeRouting': {},
  './proxy/modelCatalog': {},
  './modelIdentity': {},
  './proxy/subagentModels': {},
  './proxy/nativeSubagentResponse': {},
  './proxy/customRequest': { stopCustomRequests: vi.fn() },
  './proxy/subagentRouting': { subagentRouting: { clear: vi.fn() } },
  './modelStore': {},
  './cryptoStore': {},
  './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
  './proxy/loopbackSecurity': loopbackSecurity,
  './proxy/listen': listener,
};
const exported = {} as {
  startProxy: (options: ProxyStartOptions) => Promise<number>;
  stopProxy: () => Promise<void>;
  getProxyPort: () => number;
};
runInNewContext(compiled, {
  exports: exported,
  require: (name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  },
  URL,
  Buffer,
  process,
  setTimeout,
  clearTimeout,
});
const { getProxyPort, startProxy, stopProxy } = exported;

const clients: net.Socket[] = [];
afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  await stopProxy();
});

async function unusedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  clients.push(socket);
  socket.on('error', () => {});
  socket.resume();
  await once(socket, 'connect');
  return socket;
}

describe('bounded proxy shutdown over real TCP connections', () => {
  it.each(['response', 'request body'])('closes an unfinished %s with the default grace', async (pending) => {
    let accepted!: () => void;
    const handled = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const port = await startProxy({
      port: await unusedPort(),
      handleManagement: (_req, res) => {
        if (pending === 'response') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: still running\n\n');
        }
        accepted();
        return true;
      },
    });
    const socket = await connect(port);
    socket.write(
      `POST /_addon/pending HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${pending === 'response' ? 0 : 999}\r\n\r\n`,
    );
    await handled;
    const closed = once(socket, 'close');
    await stopProxy(); // Before the fix this never completed until the client disconnected.
    await closed;
    expect(socket.destroyed).toBe(true);
    expect(getProxyPort()).toBe(0);
  });

  it('lets a response finish within the grace period', async () => {
    let response!: http.ServerResponse;
    let accepted!: () => void;
    const handled = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const port = await startProxy({
      port: await unusedPort(),
      handleManagement: (_req, res) => {
        response = res;
        accepted();
        return true;
      },
    });
    const socket = await connect(port);
    let wire = '';
    socket.on('data', (chunk) => {
      wire += chunk.toString();
    });
    socket.write(`GET /_addon/pending HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    await handled;
    const closed = once(socket, 'close');
    const stopped = stopProxy();
    response.end('completed before shutdown');
    await stopped;
    await closed;
    expect(wire).toContain('200 OK');
    expect(wire).toContain('completed before shutdown');
  });

  it('rejects pipelined work after shutdown begins', async () => {
    let stopped!: Promise<void>;
    const handler = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) => {
      stopped = stopProxy();
      setImmediate(() => res.end('first response'));
      return true;
    });
    const port = await startProxy({ port: await unusedPort(), handleManagement: handler });
    const socket = await connect(port);
    let wire = '';
    socket.on('data', (chunk) => {
      wire += chunk.toString();
    });
    const closed = once(socket, 'close');
    socket.write(
      `GET /_addon/first HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n` +
        `GET /_addon/second HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    await closed;
    await stopped;
    expect(handler).toHaveBeenCalledOnce();
    expect(wire).toContain('503 Service Unavailable');
    expect(wire).toContain('Proxy is shutting down');
  });

  it('rejects a body completed during shutdown before starting its upstream', async () => {
    let accepted!: () => void;
    const handled = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const port = await startProxy({
      port: await unusedPort(),
      handleManagement: () => {
        accepted();
        return false;
      },
    });
    const socket = await connect(port);
    let wire = '';
    socket.on('data', (chunk) => {
      wire += chunk.toString();
    });
    const closed = once(socket, 'close');
    socket.write(
      `POST /v1internal:fetchAvailableModels HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\n\r\n`,
    );
    await handled;
    const stopped = stopProxy();
    socket.write('{}');
    await stopped;
    await closed;
    expect(wire).toContain('503 Service Unavailable');
  });

  it.each([-1, 1.5, Infinity, 60001])('refuses an invalid shutdown grace of %s', async (shutdownGraceMs) => {
    await expect(startProxy({ port: await unusedPort(), shutdownGraceMs })).rejects.toThrow('shutdown grace');
    expect(getProxyPort()).toBe(0);
  });
});
