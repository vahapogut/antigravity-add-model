import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as shared from '../proxy/shared';
import * as modelUtils from '../proxy/modelUtils';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import * as customRequest from '../proxy/customRequest';
import * as modelStore from '../modelStore';
import * as schemaValidator from '../schemaValidator';
import * as subagentRouting from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { listenProxy } from '../proxy/listen';
import type { ProxyStartOptions } from '../proxy';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const compiled = ts.transpileModule(fs.readFileSync('src/proxy.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];
const directories: string[] = [];
const route = '/exa.language_server_pb.LanguageServerService/GetAvailableModels';
afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  shared.stopCleanupInterval();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-security-'))
      throw new Error('Unexpected fixture path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function request(port: number, target: string, headers: Record<string, string> = {}, body?: unknown, method = 'POST') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(options: ProxyStartOptions = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-security-'));
  directories.push(directory);
  const calls: { path: string; authorization?: string; body: string }[] = [];
  const downloads: http.RequestOptions[] = [];
  const sink = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url!.startsWith('/provider')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture-ok' }, finish_reason: 'stop' }] }),
      );
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://attacker.invalid/steal' });
      res.end();
    } else res.end('local fixture text');
  });
  servers.push(sink);
  const lsPort = await listenProxy(sink, 0);
  modelStore.writeJsonAtomic(path.join(directory, 'custom_models.json'), {
    models: [
      {
        name: 'models/security-fixture',
        displayName: 'Security fixture',
        provider: 'openai',
        apiKey: 'synthetic-provider-key',
        encrypted: true,
        apiUrl: `http://127.0.0.1:${lsPort}/provider`,
        externalModelName: 'fixture',
        maxRetries: 0,
      },
    ],
  });
  const dependencies: Record<string, unknown> = {
    http: {
      ...http,
      createServer: (handler: http.RequestListener) => {
        const server = http.createServer(handler);
        servers.push(server);
        return server;
      },
    },
    // HTTPS options are captured, then delivered to a synthetic localhost HTTP sink.
    // No production domain, real credential, or TLS policy is contacted in this test.
    https: {
      request: (options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
        if (options instanceof URL) throw new Error('Unexpected native outbound request');
        downloads.push(options);
        return http.request({ ...options, hostname: '127.0.0.1', port: lsPort }, callback);
      },
    },
    fs,
    path,
    electron: { app: { getAppPath: () => directory } },
    'electron-log': { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    './proxy/shared': shared,
    './proxy/modelUtils': modelUtils,
    './proxy/modelCatalog': modelCatalog,
    './modelIdentity': modelIdentity,
    './proxy/customRequest': customRequest,
    './modelStore': modelStore,
    './schemaValidator': schemaValidator,
    './cryptoStore': { decryptModels: (models: unknown) => models },
    './proxy/subagentRouting': subagentRouting,
    './proxy/subagentModels': subagentModels,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/cloudCodeRouting': {},
    './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
    './proxy/loopbackSecurity': loopbackSecurity,
    './proxy/listen': {
      getRequiredProxyPort: () => undefined,
      listenProxy: (server: http.Server) => listenProxy(server, 0),
    },
  };
  const module = {
    exports: {} as {
      startProxy(options: ProxyStartOptions): Promise<number>;
      stopProxy(): Promise<void>;
      setLanguageServerPortResolver(resolve: () => number): void;
    },
  };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  proxies.push(module.exports);
  const management = vi.fn(() => false);
  const port = await module.exports.startProxy({ dataDirectory: directory, handleManagement: management, ...options });
  return { ...module.exports, port, lsPort, calls, downloads, management };
}

const generationRoute = '/v1beta/models/security-fixture:generateContent';
const prompt = { contents: [{ role: 'user', parts: [{ text: 'local synthetic request' }] }] };

describe('desktop proxy HTTP boundaries', () => {
  it('blocks foreign/malformed Host and Origin before management, generation, metrics or upstream work', async () => {
    const app = await fixture();
    const badHeaders = [
      { Host: `attacker.test:${app.port}` },
      { Host: `127.0.0.1:${app.port + 1}` },
      { Host: 'localhost' },
      { Host: `localhost.attacker.test:${app.port}` },
      { Host: `localhost:${app.port}@attacker.test` },
      { Origin: 'null' },
      { Origin: 'file://' },
      { Origin: 'https://attacker.test' },
      { Origin: `http://127.0.0.1:${app.lsPort}` },
      { Origin: `http://127.0.0.1:${app.port}/` },
    ];
    for (const headers of badHeaders)
      for (const target of ['/health', '/metrics', generationRoute]) {
        expect((await request(app.port, target, { 'Content-Type': 'text/plain', ...headers }, prompt)).status).toBe(
          403,
        );
      }
    expect(app.management).not.toHaveBeenCalled();
    expect(app.calls).toHaveLength(0);
  });

  it('rejects duplicate Host/Origin headers even if Node keeps the first valid Host', async () => {
    const app = await fixture();
    for (const duplicate of [
      `Host: attacker.test`,
      `Origin: http://127.0.0.1:${app.port}\r\nOrigin: https://attacker.test`,
    ]) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(app.port, '127.0.0.1', () =>
          socket.end(
            `GET /health HTTP/1.1\r\nHost: localhost:${app.port}\r\n${duplicate}\r\nConnection: close\r\n\r\n`,
          ),
        );
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => (text += chunk));
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(response).toMatch(/^HTTP\/1\.1 403 /);
    }
  });

  it('keeps native localhost callers, same-origin browser calls and only the registered live LS origin working', async () => {
    const app = await fixture();
    for (const host of ['localhost', '127.0.0.1']) {
      const headers = { Host: `${host}:${app.port}`, Origin: `http://${host}:${app.port}` };
      expect((await request(app.port, generationRoute, headers, prompt)).status).toBe(200);
    }
    expect((await request(app.port, generationRoute, { Host: `localhost:${app.port}` }, prompt)).status).toBe(200);
    let activePort = app.lsPort;
    app.setLanguageServerPortResolver(() => activePort);
    expect(
      (await request(app.port, generationRoute, { Origin: `https://127.0.0.1:${activePort}` }, prompt)).status,
    ).toBe(200);
    const oldPort = activePort;
    activePort = app.port === 54321 ? 54322 : 54321;
    expect((await request(app.port, generationRoute, { Origin: `https://127.0.0.1:${oldPort}` }, prompt)).status).toBe(
      403,
    );
    expect(app.calls.every((call) => call.authorization === 'Bearer synthetic-provider-key')).toBe(true);
    app.setLanguageServerPortResolver(() => {
      throw new Error('LS unavailable');
    });
    expect(
      (await request(app.port, generationRoute, { Origin: `https://127.0.0.1:${activePort}` }, prompt)).status,
    ).toBe(403);
    expect((await request(app.port, generationRoute, {}, prompt)).status).toBe(200);
  });

  it('keeps IDE service mode isolated from a registered desktop LS resolver', async () => {
    const app = await fixture({ allowLanguageServerRouting: false });
    app.setLanguageServerPortResolver(() => app.lsPort);
    expect(
      (await request(app.port, generationRoute, { Origin: `https://127.0.0.1:${app.lsPort}` }, prompt)).status,
    ).toBe(403);
    const target = `https://127.0.0.1:${app.lsPort}${route}`;
    expect((await request(app.port, `/GetAvailableModels?ls=${encodeURIComponent(target)}`, {}, {})).status).toBe(400);
    expect(app.calls).toHaveLength(0);
    expect((await request(app.port, generationRoute, {}, prompt)).status).toBe(200);
  });

  it('binds model-list forwarding to the registered LS port and RPC path, including its local TLS exception', async () => {
    const app = await fixture();
    const target = `https://127.0.0.1:${app.lsPort}${route}`;
    const forward = (url: string) => request(app.port, `/GetAvailableModels?ls=${encodeURIComponent(url)}`, {}, {});
    expect((await forward(target)).status).toBe(400);
    app.setLanguageServerPortResolver(() => app.lsPort);
    for (const rejected of [
      `http://127.0.0.1:${app.port}${route}`,
      `https://attacker.test:${app.lsPort}${route}`,
      `http://127.0.0.1:${app.lsPort}/admin`,
      `${target}?redirect=1`,
      `${target}#fragment`,
      `https://user@127.0.0.1:${app.lsPort}${route}`,
      `file:///etc/hosts`,
    ])
      expect((await forward(rejected)).status).toBe(400);
    expect(app.calls).toHaveLength(0);
    expect((await forward(target)).status).toBe(200);
    expect(app.downloads).toHaveLength(1);
    expect(app.downloads[0]).toMatchObject({
      hostname: '127.0.0.1',
      port: String(app.lsPort),
      path: route,
      rejectUnauthorized: false,
    });
    expect((await forward(`http://127.0.0.1:${app.lsPort}/LanguageServerService/GetAvailableModels`)).status).toBe(200);
    expect(app.calls).toHaveLength(2);
  });

  it('never downloads non-Google fileData with incoming credentials; Google downloads preserve TLS and do not follow redirects', async () => {
    const app = await fixture();
    const send = (fileUri: string, mimeType = 'text/plain') =>
      request(
        app.port,
        generationRoute,
        { Authorization: 'Bearer synthetic-google-token' },
        { contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType } }] }] },
      );
    for (const uri of [
      'https://attacker.test/file',
      'https://googleapis.com.attacker.test/file',
      'https://attacker.test@googleapis.com/file',
      'http://generativelanguage.googleapis.com/file',
      'https://generativelanguage.googleapis.com:444/file',
    ])
      expect((await send(uri)).status).toBe(200);
    expect(app.downloads).toHaveLength(0);
    expect((await send('https://generativelanguage.googleapis.com/file')).status).toBe(200);
    expect(app.downloads[0]).toMatchObject({
      hostname: 'generativelanguage.googleapis.com',
      path: '/file',
      headers: { Authorization: 'Bearer synthetic-google-token' },
    });
    expect(app.downloads[0]).not.toHaveProperty('rejectUnauthorized', false);
    expect(app.calls.find((call) => call.path === '/file')?.authorization).toBe('Bearer synthetic-google-token');
    expect((await send('https://generativelanguage.googleapis.com/redirect')).status).toBe(200);
    expect(app.downloads).toHaveLength(2);
    expect(app.downloads.some((call) => call.hostname === 'attacker.invalid')).toBe(false);
    await send('https://generativelanguage.googleapis.com/image.png', 'image/png');
    expect(app.downloads).toHaveLength(2);
  });
});

describe('URL boundary edge cases', () => {
  it.each([
    'https://googleapis.com.evil.test/x',
    'https://googleapis.com./x',
    'https://googleapis.com@evil.test/x',
    'https://evilgoogleapis.com/x',
    'https://googleapis.com:444/x',
    'file:///x',
    'https://evil.test/googleapis.com/x',
  ])('rejects a non-Google authenticated file target: %s', (value) => {
    expect(loopbackSecurity.authenticatedGoogleFileUrl(value)).toBeUndefined();
  });
  it.each([
    'http://127.1:12345',
    'http://2130706433:12345',
    'http://localhost.:12345',
    'http://[::1]:12345',
    'http://localhost:12346',
  ])('rejects an unregistered or noncanonical LS authority: %s', (origin) => {
    expect(loopbackSecurity.languageServerModelsUrl(`${origin}${route}`, 12345)).toBeUndefined();
  });
});
