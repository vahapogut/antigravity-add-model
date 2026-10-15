import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as subagentRoutingModule from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { CustomModel } from '../proxy';
import * as shared from '../proxy/shared';
import * as modelUtils from '../proxy/modelUtils';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import * as customRequest from '../proxy/customRequest';
import * as modelStore from '../modelStore';
import * as schemaValidator from '../schemaValidator';
import { listenProxy } from '../proxy/listen';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=';
const directories: string[] = [];
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  shared.stopCleanupInterval();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-vision-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  const port = await listenProxy(server, 0);
  return `http://127.0.0.1:${port}`;
}

async function fixture(models: CustomModel[]) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-vision-'));
  directories.push(directory);
  modelStore.writeJsonAtomic(path.join(directory, '.gemini/antigravity/custom_models.json'), { models });
  const imagePath = path.join(directory, 'image with spaces #1.png');
  fs.writeFileSync(imagePath, Buffer.from(png, 'base64'));
  const remoteDownload = vi.fn(() => {
    throw new Error('Unexpected image download');
  });
  const dependencies: Record<string, unknown> = {
    http,
    https: { request: remoteDownload },
    fs,
    path,
    electron: { app: { getPath: () => directory, getAppPath: () => directory } },
    'electron-log': { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    './proxy/shared': shared,
    './proxy/modelUtils': modelUtils,
    './proxy/modelCatalog': modelCatalog,
    './proxy/subagentRouting': subagentRoutingModule,
    './proxy/subagentModels': subagentModels,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/cloudCodeRouting': {},
    './modelIdentity': modelIdentity,
    './proxy/customRequest': customRequest,
    './modelStore': modelStore,
    './schemaValidator': schemaValidator,
    './cryptoStore': { decryptModels: (value: unknown) => value },
    './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
    './proxy/loopbackSecurity': loopbackSecurity,
    './proxy/listen': {
      getRequiredProxyPort: () => undefined,
      listenProxy: (server: http.Server) => listenProxy(server, 0),
    },
  };
  const module = { exports: {} as { startProxy(): Promise<number>; stopProxy(): Promise<void> } };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
  });
  proxies.push(module.exports);
  const port = await module.exports.startProxy();
  return { url: `http://127.0.0.1:${port}`, fileUri: pathToFileURL(imagePath).href, remoteDownload };
}

function model(apiUrl: string, apiFormat?: 'openai' | 'anthropic'): CustomModel {
  return {
    name: 'models/deepseek-vision-test',
    displayName: 'DeepSeek vision test',
    description: '',
    provider: 'deepseek',
    apiKey: 'fixture-key',
    encrypted: true,
    apiUrl,
    externalModelName: 'deepseek-vl2',
    supportsVision: true,
    maxRetries: 0,
    contextWindow: 32768,
    ...(apiFormat ? { apiFormat } : {}),
  };
}

const cases = (['openai', 'anthropic', undefined] as const).flatMap((apiFormat) =>
  [false, true].flatMap((cloud) =>
    [false, true].map((stream) => ({
      apiFormat,
      format: apiFormat || 'anthropic',
      cloud,
      stream,
    })),
  ),
);

describe('images through the desktop HTTP proxy', () => {
  it.each(cases)(
    'preserves images for $apiFormat, cloud=$cloud, stream=$stream',
    async ({ apiFormat, format, cloud, stream }) => {
      let received: { model?: string; stream?: boolean; messages?: unknown[] } = {};
      let upstreamPath = '';
      const upstream = await serve((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          upstreamPath = req.url || '';
          if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            const events =
              format === 'openai'
                ? [{ choices: [{ delta: { content: 'Image received' }, finish_reason: 'stop' }] }]
                : [
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Image received' } },
                    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                  ];
            for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (format === 'openai') res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify(
                format === 'openai'
                  ? { choices: [{ message: { content: 'Image received' }, finish_reason: 'stop' }] }
                  : { content: [{ type: 'text', text: 'Image received' }], stop_reason: 'end_turn' },
              ),
            );
          }
        });
      });
      const selected = model(upstream, apiFormat);
      const app = await fixture([selected]);
      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Compare these images' },
              { inlineData: { mimeType: 'image/png', data: png } },
              { fileData: { mimeType: 'image/png', fileUri: app.fileUri } },
              { fileData: { mimeType: 'image/jpeg', fileUri: 'https://images.example.test/public.jpg' } },
              { text: 'Describe the difference' },
            ],
          },
        ],
      };
      const method = stream ? 'streamGenerateContent' : 'generateContent';
      const endpoint = cloud ? `/v1internal:${method}` : `/v1beta/${selected.name}:${method}`;
      const response = await fetch(app.url + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer incoming-google-token' },
        body: JSON.stringify(cloud ? { model: selected.name, request } : request),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Image received');
      expect(upstreamPath).toBe(format === 'openai' ? '/v1/chat/completions' : '/v1/messages');
      expect(received.model).toBe('deepseek-vl2');
      expect(received.stream).toBe(stream);
      const embedded =
        format === 'openai'
          ? { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
          : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
      const remote =
        format === 'openai'
          ? { type: 'image_url', image_url: { url: 'https://images.example.test/public.jpg' } }
          : { type: 'image', source: { type: 'url', url: 'https://images.example.test/public.jpg' } };
      expect(received.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these images' },
            embedded,
            embedded,
            remote,
            { type: 'text', text: 'Describe the difference' },
          ],
        },
      ]);
      expect(app.remoteDownload).not.toHaveBeenCalled();
      expect(JSON.stringify(received)).not.toContain('incoming-google-token');
    },
  );

  it.each(['openai', 'anthropic'] as const)(
    'rejects invalid %s image input without upstream retry or fallback',
    async (format) => {
      let attempts = 0;
      const upstream = await serve((_req, res) => {
        attempts++;
        res.end('{}');
      });
      const fallback = { ...model(upstream, format), name: 'models/fallback' };
      const selected = { ...model(upstream, format), maxRetries: 3, fallbackModels: [fallback.name] };
      const app = await fixture([selected, fallback]);
      const before = customRequest.getProxyMetrics();
      const response = await fetch(`${app.url}/v1beta/${selected.name}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'private-invalid-image!!!!' } }] },
          ],
        }),
      });
      expect(response.status).toBe(400);
      const message = await response.text();
      expect(message.toLowerCase()).toMatch(/image|base64/);
      expect(message).not.toContain('private-invalid-image');
      expect(attempts).toBe(0);
      const after = customRequest.getProxyMetrics();
      expect(after.retries).toBe(before.retries);
      expect(after.fallbacks).toBe(before.fallbacks);
      expect(after.upstreamAttempts).toBe(before.upstreamAttempts);
    },
  );
});
