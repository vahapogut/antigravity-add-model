import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as subagentRoutingModule from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { getRequiredProxyPort, listenProxy } from '../proxy/listen';

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

class FakeServer extends EventEmitter {
  listening = false;
  port = 0;
  listen = vi.fn((port: number, _host: string) => {
    this.port = port || 61000;
    return this;
  });
  close = vi.fn((callback: () => void) => {
    this.listening = false;
    callback();
    return this;
  });
  address() {
    return { port: this.port, address: '127.0.0.1', family: 'IPv4' };
  }
  ready() {
    this.listening = true;
    this.emit('listening');
  }
}

interface ProxyModule {
  startProxy(): Promise<number>;
  stopProxy(): Promise<void>;
  getProxyPort(): number;
}
const fixtures: { module: ProxyModule; directory: string; servers: FakeServer[] }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const server of fixture.servers) if (server.listenerCount('listening')) server.ready();
    await fixture.module.stopProxy();
    if (
      path.dirname(fixture.directory) !== path.resolve(tmpdir()) ||
      !path.basename(fixture.directory).startsWith('agy-proxy-lifecycle-')
    ) {
      throw new Error('Unexpected fixture cleanup path');
    }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(fixed = true) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-proxy-lifecycle-'));
  if (fixed) fs.writeFileSync(path.join(directory, 'antigravity-proxy.json'), '{"requiredPort":50999}');
  const servers: FakeServer[] = [];
  const createServer = vi.fn((_listener: http.RequestListener) => {
    const server = new FakeServer();
    servers.push(server);
    return server;
  });
  const startCleanupInterval = vi.fn();
  const stopCleanupInterval = vi.fn();
  const dependencies: Record<string, unknown> = {
    http: { createServer },
    https: {},
    fs: {},
    path,
    electron: { app: { getAppPath: () => directory } },
    'electron-log': { info: vi.fn(), error: vi.fn() },
    './proxy/shared': {
      startCleanupInterval,
      stopCleanupInterval,
      activeStreamContexts: new Map(),
      modelToolCallIds: new Map(),
      translatedToolCalls: new Map(),
      modelReasoningContent: new Map(),
    },
    './proxy/modelUtils': {},
    './proxy/modelCatalog': {},
    './proxy/subagentRouting': subagentRoutingModule,
    './proxy/subagentModels': subagentModels,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/cloudCodeRouting': {},
    './modelIdentity': {},
    './proxy/customRequest': { stopCustomRequests: vi.fn(), getProxyMetrics: () => ({ requests: 0 }) },
    './modelStore': {},
    './cryptoStore': {},
    './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
    // These are the production marker parser and listener, with only the socket mocked.
    './proxy/loopbackSecurity': loopbackSecurity,
    './proxy/listen': { getRequiredProxyPort, listenProxy },
  };
  const module = { exports: {} as ProxyModule };
  runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
    console,
    URL,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
  });
  fixtures.push({ module: module.exports, directory, servers });
  return { ...module.exports, servers, createServer, startCleanupInterval, stopCleanupInterval };
}

describe('proxy lifecycle across language-server restarts', () => {
  it('rejects malformed request and language-server targets without losing its HTTP listener', async () => {
    const proxy = fixture();
    const started = proxy.startProxy();
    proxy.servers[0].ready();
    await started;
    const server = http.createServer(proxy.createServer.mock.calls[0][0]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const rawRequest = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
        });
        let response = '';
        socket.setEncoding('utf8');
        socket.setTimeout(2000, () => socket.destroy(new Error('HTTP response timed out')));
        socket.on('data', (chunk) => {
          response += chunk;
        });
        socket.on('end', () => resolve(response));
        socket.on('error', reject);
      });
    try {
      for (const target of [
        '//[',
        '//example.invalid/',
        '/\\example.invalid/',
        'http://example.invalid/',
        '/GetAvailableModels?ls=%2F%2F%5B',
        '/GetAvailableModels?ls=file%3A%2F%2F%2Ftmp',
      ]) {
        expect(await rawRequest(target)).toMatch(/^HTTP\/1\.1 400 /);
      }
      expect(await rawRequest('/health')).toMatch(/^HTTP\/1\.1 200 /);
      const metrics = await rawRequest('/metrics?check=1');
      expect(metrics).toMatch(/^HTTP\/1\.1 200 /);
      expect(metrics).toContain('"requests":0');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reuses its existing listener when the fixed-port language server restarts', async () => {
    const proxy = fixture();
    const initial = proxy.startProxy();
    expect(proxy.servers[0].listen).toHaveBeenCalledWith(50999, '127.0.0.1');
    proxy.servers[0].ready();
    await expect(initial).resolves.toBe(50999);
    await expect(proxy.startProxy()).resolves.toBe(50999);
    expect(proxy.createServer).toHaveBeenCalledOnce();
    expect(proxy.startCleanupInterval).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent startup requests onto one in-flight listener', async () => {
    const proxy = fixture();
    const first = proxy.startProxy();
    const second = proxy.startProxy();
    expect(proxy.createServer).toHaveBeenCalledOnce();
    proxy.servers[0].ready();
    await expect(Promise.all([first, second])).resolves.toEqual([50999, 50999]);
  });

  it('clears a failed start so a later retry can bind the fixed port', async () => {
    const proxy = fixture();
    const failed = proxy.startProxy();
    const assertion = expect(failed).rejects.toMatchObject({ code: 'EADDRINUSE' });
    proxy.servers[0].emit('error', Object.assign(new Error('Port occupied'), { code: 'EADDRINUSE' }));
    await assertion;
    expect(proxy.getProxyPort()).toBe(0);
    expect(proxy.stopCleanupInterval).toHaveBeenCalledOnce();

    const retried = proxy.startProxy();
    expect(proxy.createServer).toHaveBeenCalledTimes(2);
    proxy.servers[1].ready();
    await expect(retried).resolves.toBe(50999);
  });

  it('clears the bound port on shutdown and allows an explicit fresh start', async () => {
    const proxy = fixture();
    const started = proxy.startProxy();
    proxy.servers[0].ready();
    await started;
    await Promise.all([proxy.stopProxy(), proxy.stopProxy()]);
    expect(proxy.servers[0].close).toHaveBeenCalledOnce();
    expect(proxy.getProxyPort()).toBe(0);
    const restarted = proxy.startProxy();
    proxy.servers[1].ready();
    await expect(restarted).resolves.toBe(50999);
  });

  it('waits for an in-flight start before shutting its listener down', async () => {
    const proxy = fixture();
    const started = proxy.startProxy();
    const stopped = proxy.stopProxy();
    expect(proxy.servers[0].close).not.toHaveBeenCalled();
    proxy.servers[0].ready();
    await started;
    await stopped;
    expect(proxy.servers[0].close).toHaveBeenCalledOnce();
    expect(proxy.getProxyPort()).toBe(0);
  });

  it('discards routes created by a final native response while shutdown drains requests', async () => {
    const proxy = fixture();
    const started = proxy.startProxy();
    proxy.servers[0].ready();
    await started;
    let finishClose = () => {};
    proxy.servers[0].close.mockImplementation((callback) => {
      finishClose = () => {
        proxy.servers[0].listening = false;
        callback();
      };
      return proxy.servers[0];
    });
    const stopped = proxy.stopProxy();
    const bridge = subagentRoutingModule.subagentRouting;
    const resolve = (selector: string) => (selector === 'models/child' ? selector : undefined);
    const parent = bridge.prepareRequest({ conversationId: 'shutdown-parent', contents: [] }, resolve);
    const candidate = bridge.rewriteCandidate(
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'invoke_subagent',
                args: { Subagents: [{ Model: 'models/child', Prompt: 'Work' }] },
              },
            },
          ],
        },
      },
      parent.context,
      resolve,
    );
    const prompt = candidate.content.parts[0].functionCall.args.Subagents[0].Prompt;
    const child = { conversationId: 'shutdown-child', contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    expect(bridge.prepareRequest(child, resolve).modelName).toBe('models/child');

    finishClose();
    await stopped;
    expect(() => bridge.prepareRequest(child, resolve)).toThrow('expired or is unknown');
    expect(
      bridge.prepareRequest({ conversationId: 'shutdown-child', contents: [] }, resolve).modelName,
    ).toBeUndefined();
  });

  it('queues a start requested while the old listener is shutting down', async () => {
    const proxy = fixture();
    const started = proxy.startProxy();
    proxy.servers[0].ready();
    await started;
    let finishClose = () => {};
    proxy.servers[0].close.mockImplementation((callback) => {
      finishClose = () => {
        proxy.servers[0].listening = false;
        callback();
      };
      return proxy.servers[0];
    });
    const stopped = proxy.stopProxy();
    const restarted = proxy.startProxy();
    expect(proxy.createServer).toHaveBeenCalledOnce();
    finishClose();
    await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxy.createServer).toHaveBeenCalledTimes(2);
    proxy.servers[1].ready();
    await expect(restarted).resolves.toBe(50999);
  });

  it('continues to reuse the dynamic fallback for an unpatched application', async () => {
    const proxy = fixture(false);
    const started = proxy.startProxy();
    proxy.servers[0].emit('error', Object.assign(new Error('Port occupied'), { code: 'EADDRINUSE' }));
    expect(proxy.servers[0].listen).toHaveBeenLastCalledWith(0, '127.0.0.1');
    proxy.servers[0].ready();
    await expect(started).resolves.toBe(61000);
    await expect(proxy.startProxy()).resolves.toBe(61000);
    expect(proxy.createServer).toHaveBeenCalledOnce();
  });
});
