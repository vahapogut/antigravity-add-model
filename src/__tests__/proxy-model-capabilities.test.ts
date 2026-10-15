import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as subagentRoutingModule from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { detectModelCapabilities, nativeCatalogCapabilities, nativeModelExperiments } from '../proxy/modelUtils';
import { validateCustomModel } from '../schemaValidator';
import * as modelCatalog from '../proxy/modelCatalog';
import { runCustomModelRequest } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';
import { allocateModelIdentities, IdentityModel } from '../modelIdentity';

const identityDirectories: string[] = [];
afterAll(() => {
  stopCleanupInterval();
  for (const directory of identityDirectories) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-catalog-'))
      throw new Error('Unexpected cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type Failure = 'error' | 'timeout' | 'before-headers' | 'upstream-error';
function requestModels(
  url: string,
  body: unknown,
  failure?: Failure,
  config: Record<string, unknown> = {},
  fixture?: {
    models: Record<string, unknown>[];
    captureHandler: (handler: http.RequestListener) => void;
  },
) {
  const identityDirectory = fs.mkdtempSync(path.join(tmpdir(), 'agy-catalog-'));
  identityDirectories.push(identityDirectory);
  const models =
    fixture?.models ||
    [
      { externalModelName: 'deepseek-vl2', displayName: 'Automatic vision' },
      { externalModelName: 'deepseek-r1', displayName: 'Enabled vision', supportsVision: true },
      { externalModelName: 'deepseek-ai/Janus-Pro-7B', displayName: 'Disabled vision', supportsVision: false },
    ].map((model, i) => ({
      ...model,
      name: `models/custom-${i}`,
      provider: 'deepseek',
      apiFormat: 'openai',
      apiUrl: 'https://example.test/v1',
      apiKey: '',
      description: 'A custom model',
      ...config,
    }));
  const request = (_url: URL, _options: unknown, callback: (response: EventEmitter) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: () => void;
    };
    let timeout: (() => void) | undefined;
    outgoing.setTimeout = vi.fn((_ms: number, handler: () => void) => {
      timeout = handler;
    });
    outgoing.destroy = vi.fn();
    outgoing.write = vi.fn();
    outgoing.end = () => {
      if (failure === 'error') return void outgoing.emit('error', new Error('Fixture connection failure'));
      if (failure === 'before-headers') return timeout!();
      const upstream = Object.assign(new EventEmitter(), { statusCode: failure === 'upstream-error' ? 403 : 200 });
      callback(upstream);
      if (failure === 'timeout') return timeout!();
      upstream.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      upstream.emit('end');
    };
    return outgoing;
  };
  const dependencies: Record<string, unknown> = {
    http: {},
    https: { request },
    fs: { existsSync: () => true },
    path,
    electron: { app: { getPath: () => '/fixture' } },
    'electron-log': { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    './proxy/shared': {},
    './proxy/modelUtils': { detectModelCapabilities, nativeCatalogCapabilities, nativeModelExperiments },
    './proxy/modelCatalog': modelCatalog,
    './proxy/subagentRouting': subagentRoutingModule,
    './proxy/subagentModels': subagentModels,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/cloudCodeRouting': {},
    './modelIdentity': {
      allocateModelIdentities: (_directory: string, models: IdentityModel[], upstream?: unknown) =>
        allocateModelIdentities(identityDirectory, models, upstream),
    },
    './proxy/customRequest': { runCustomModelRequest },
    './modelStore': { readModelConfig: () => models },
    './cryptoStore': { decryptModels: (value: unknown) => value },
    './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
    './schemaValidator': { validateCustomModel },
    './proxy/loopbackSecurity': loopbackSecurity,
    './proxy/listen': {},
  };
  const module = { exports: {} as { handleRequest: http.RequestListener } };
  runInNewContext(`${compiled}\nexports.handleRequest = handleRequest;`, {
    exports: module.exports,
    module,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
    URL,
    Buffer,
    console,
    process,
  });
  fixture?.captureHandler(module.exports.handleRequest);
  const req = Object.assign(new EventEmitter(), { url, method: 'GET', headers: {} });
  const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
  module.exports.handleRequest(req as http.IncomingMessage, res as unknown as http.ServerResponse);
  req.emit('end');
  expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
  expect(res.end).toHaveBeenCalledOnce();
  return JSON.parse(res.end.mock.calls[0][0]);
}

function checkCapabilities(container: Record<string, unknown> | unknown[]) {
  const models = (Array.isArray(container) ? container : Object.values(container)) as {
    displayName: string;
    supportsImages: boolean;
    supportedMimeTypes: Record<string, boolean>;
  }[];
  for (const displayName of ['Automatic vision', 'Enabled vision', 'Disabled vision']) {
    const model = models.find((entry) => entry.displayName === displayName);
    const images = displayName !== 'Disabled vision';
    expect(model, displayName).toBeDefined();
    expect(model!.supportsImages, displayName).toBe(images);
    expect(model!.supportedMimeTypes['image/png'], displayName).toBe(images ? true : undefined);
    expect(model!.supportedMimeTypes['image/jpeg'], displayName).toBe(images ? true : undefined);
    expect(model!.supportedMimeTypes['image/heic'], displayName).toBeUndefined();
    expect(model!.supportedMimeTypes['text/plain'], displayName).toBe(true);
  }
}

describe('custom model vision capability advertisement', () => {
  it.each([
    { config: { provider: 'google', apiFormat: 'google' }, native: true },
    { config: { provider: 'google-cloudcode', apiFormat: undefined }, native: true },
    { config: { provider: 'google', apiFormat: 'openai' }, native: false },
    { config: { provider: 'google', apiFormat: 'google', gateway: true }, native: false },
  ])('keeps HEIC/HEIF only for native Google routes: $config', ({ config, native }) => {
    const response = requestModels('/v1internal:fetchAvailableModels', { models: {} }, undefined, config);
    expect(Object.values(response.models)).toHaveLength(3);
    for (const entry of Object.values(response.models) as {
      supportsImages: boolean;
      supportedMimeTypes: Record<string, boolean>;
    }[]) {
      expect(entry.supportedMimeTypes['image/heic']).toBe(native && entry.supportsImages ? true : undefined);
      expect(entry.supportedMimeTypes['image/heif']).toBe(native && entry.supportsImages ? true : undefined);
    }
  });

  it.each(['models', 'availableModels', 'available_models'])(
    'advertises the same capabilities in %s maps and arrays',
    (key) => {
      for (const native of [{ native: { displayName: 'Native' } }, [{ displayName: 'Native' }]]) {
        const response = requestModels('/v1internal:fetchAvailableModels', { [key]: native });
        checkCapabilities(response[key]);
        expect(Object.values(response[key])).toContainEqual({ displayName: 'Native' });
      }
    },
  );
  it('keeps real context limits in the provider-facing model listing with native compatibility enabled', () => {
    const response = requestModels('/v1beta/models', { models: [] }, undefined, {
      provider: 'ollama', externalModelName: 'qwen3.8:27b', contextWindow: 85000,
      maxOutputTokens: 8192, compactionThresholdPercent: 80,
    });
    expect(response.models).toHaveLength(3);
    for (const entry of response.models) {
      expect(entry).toMatchObject({ inputTokenLimit: 85000, outputTokenLimit: 8192 });
      expect(entry).not.toHaveProperty('maxTokens', 90000);
    }
  });

  it.each([
    { label: 'missing collection', body: { status: 'ok' } },
    { label: 'invalid JSON', body: 'invalid-json' },
    { label: 'connection error', failure: 'error' as const },
    { label: 'timeout', failure: 'timeout' as const },
  ])('advertises vision when fetchAvailableModels falls back after $label', ({ body, failure }) => {
    checkCapabilities(requestModels('/v1internal:fetchAvailableModels', body, failure).models);
  });

  it.each([
    { label: 'successful list', body: { models: [] } },
    { label: 'invalid JSON', body: 'invalid-json' },
    { label: 'connection error', failure: 'error' as const },
    { label: 'timeout', failure: 'timeout' as const },
  ])('advertises vision in the Gemini models endpoint: $label', ({ body, failure }) => {
    checkCapabilities(requestModels('/v1beta/models', body, failure).models);
  });
});

describe('IDE Cloud Code catalog and picker groups', () => {
  function customIds(response: Record<string, any>): string[] {
    const collection = response.models || response.availableModels || response.available_models;
    return Array.isArray(collection)
      ? collection
          .filter((model: any) => model.name?.startsWith('models/custom-'))
          .map((model: any) => model.name.replace(/^models\//, ''))
      : Object.keys(collection).filter((id) => id.startsWith('custom-'));
  }
  function sortedIds(response: Record<string, any>): string[] {
    return response.agentModelSorts.flatMap((sort: any) =>
      (sort.groups || []).flatMap((group: any) => group.modelIds || []),
    );
  }
  it.each([
    { models: {} },
    { models: {}, agentModelSorts: [] },
    { models: {}, agentModelSorts: [{ displayName: 'Empty', groups: [] }] },
    { models: {}, agentModelSorts: [{ displayName: 'Partial', groups: [{}] }] },
    { availableModels: [] },
    { available_models: [] },
  ])('creates a usable custom picker group for missing, empty and array catalogs: %j', (body) => {
    const response = requestModels('/v1internal:fetchAvailableModels', body);
    const ids = customIds(response);
    expect(ids).toHaveLength(3);
    expect(sortedIds(response)).toEqual(ids);
  });
  it('preserves native models and nested sort metadata while adding each configured alias once', () => {
    const response = requestModels('/v1internal:fetchAvailableModels', {
      models: { native: { displayName: 'Native' } },
      agentModelSorts: [
        { displayName: 'Recommended', groups: [{ displayName: 'Group', modelIds: ['native', 'custom-deepseek-vl2'] }] },
      ],
    });
    expect(response.models.native).toEqual({ displayName: 'Native' });
    expect(response.agentModelSorts[0].groups[0].displayName).toBe('Group');
    expect(sortedIds(response)).toEqual(['native', ...customIds(response)]);
  });
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])(
    'keeps native summarization on the custom model when compaction effort is %s',
    (compactionReasoningEffort) => {
      const native = {
        displayName: 'Native summary model',
        model: 'MODEL_PLACEHOLDER_M50',
        modelExperiments: { experiments: { vendorSetting: { boolValue: true } } },
      };
      const response = requestModels('/v1internal:fetchAvailableModels', { models: { native } }, undefined, {
        compactionReasoningEffort,
      });
      expect(response.models.native).toEqual(native);
      for (const id of customIds(response)) {
        const entry = response.models[id];
        expect(entry.model).not.toBe(native.model);
        const checkpointConfig = JSON.parse(
          entry.modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue,
        );
        // Leave thresholds intact and keep the native summary output cap.
        expect(checkpointConfig).toEqual({ useLastPlannerModel: true, maxOutputTokens: 8192 });
      }
    },
  );
  it('preserves the native default summary route when custom compaction effort is inherited', () => {
    const response = requestModels('/v1internal:fetchAvailableModels', { models: {} });
    for (const id of customIds(response)) expect(response.models[id]).not.toHaveProperty('modelExperiments');
  });

  it.each(['models', 'availableModels', 'available_models'])(
    'adds the bounded native compatibility floor with a checkpoint policy based on real limits in %s', (key) => {
      const native = { displayName: 'Native', maxTokens: 128000 };
      const response = requestModels('/v1internal:fetchAvailableModels', { [key]: { native } }, undefined, {
        provider: 'ollama', externalModelName: 'qwen3.8:27b', contextWindow: 85000,
        maxOutputTokens: 8192, compactionThresholdPercent: 80,
      });
      expect(response[key].native).toEqual(native);
      for (const id of customIds(response)) {
        const entry = response[key][id];
        expect(entry).toMatchObject({ maxTokens: 90000, maxOutputTokens: 8192 });
        expect(JSON.parse(entry.modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue))
          .toEqual({ tokenThreshold: 68000, maxTokenLimit: 75784 });
      }
    },
  );
  it.each(['error', 'timeout', 'before-headers', 'upstream-error'] as const)(
    'returns configured picker models after %s without inventing native models or credentials',
    (failure) => {
      const response = requestModels(
        '/v1internal:fetchAvailableModels',
        { error: { message: 'private-upstream-detail' } },
        failure,
      );
      expect(customIds(response)).toHaveLength(3);
      expect(sortedIds(response)).toEqual(customIds(response));
      expect(Object.keys(response.models)).toHaveLength(3);
      expect(response).not.toHaveProperty('error');
      expect(JSON.stringify(response)).not.toContain('private-upstream-detail');
    },
  );
  it('keeps local effort variants with the same provider model as distinct stable catalog aliases', () => {
    const response = requestModels('/v1internal:fetchAvailableModels', { models: {} }, undefined, {
      externalModelName: 'shared-upstream',
    });
    const ids = customIds(response);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(sortedIds(response)).toEqual(ids);
    const entries = [0, 1, 2].map((id) => ({ name: `models/custom-${id}`, externalModelName: 'shared-upstream' }));
    for (let i = 0; i < entries.length; i++) {
      const slug = modelCatalog.catalogModelSlug(entries[i], entries);
      expect(ids).toContain(slug);
      expect(entries.filter((entry) => modelCatalog.matchesModelSlug(entry, slug, entries))).toEqual([entries[i]]);
      expect(modelCatalog.matchesModelSlug(entries[i], slug, [entries[i]])).toBe(true);
      expect(modelCatalog.matchesModelSlug(entries[i], 'custom-shared-upstream', entries)).toBe(false);
    }
  });

  it('keeps duplicate custom labels and native labels distinct for the IDE label-based picker', () => {
    const native = { native: { displayName: 'Shared label', model: 'MODEL_PLACEHOLDER_M30' } };
    const response = requestModels('/v1internal:fetchAvailableModels', { models: native }, undefined, {
      displayName: 'Shared label',
      externalModelName: 'shared-upstream',
    });
    const labels = Object.values(response.models).map((entry: any) => entry.displayName);
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
    expect(response.models.native).toEqual(native.native);
    const custom = customIds(response).map((id) => response.models[id]);
    expect(new Set(custom.map((entry) => entry.model)).size).toBe(3);
    expect(custom.every((entry) => entry.model !== native.native.model)).toBe(true);
  });

  it.each(['slug', 'enum', 'numeric', 'modelId-only', 'saved-name'])(
    'routes every emitted effort variant by %s to its saved reasoning setting through the real translator',
    async (selector) => {
      const captured: { model: string; reasoning_effort: string }[] = [];
      const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      let proxy: http.Server | undefined;
      try {
        const models = ['low', 'medium', 'high'].map((effort) => ({
          name: `models/effort-${effort}`,
          displayName: `Effort ${effort}`,
          description: '',
          provider: 'openai',
          apiFormat: 'openai',
          apiKey: '',
          apiUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
          externalModelName: 'same-upstream',
          reasoningEffort: effort,
          maxRetries: 0,
        }));
        // An exact saved name must win over another model's generated routing alias.
        models[1].name = `models/${modelCatalog.localModelSlug(models[0])}`;
        let handler: http.RequestListener | undefined;
        const catalog = requestModels(
          '/v1internal:fetchAvailableModels',
          { models: {} },
          undefined,
          {},
          {
            models,
            captureHandler: (value) => {
              handler = value;
            },
          },
        );
        proxy = http.createServer(handler!);
        await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
        expect(new Set(Object.values(catalog.models).map((entry: any) => entry.model)).size).toBe(3);
        for (const model of models) {
          const slug = modelCatalog.catalogModelSlug(model, models);
          expect(catalog.models[slug].displayName).toBe(model.displayName);
          const enumName = catalog.models[slug].model;
          const identity =
            selector === 'modelId-only'
              ? { modelId: enumName }
              : {
                  model:
                    selector === 'saved-name'
                      ? model.name
                      : selector === 'slug'
                        ? slug
                        : selector === 'numeric'
                          ? Number(enumName.slice('MODEL_PLACEHOLDER_M'.length)) + 1000
                          : enumName,
                };
          const response = await fetch(
            `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1internal:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...identity,
                request: { contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }] },
              }),
            },
          );
          expect(response.status).toBe(200);
          expect(await response.text()).toContain('OK');
        }
        expect(captured.map((request) => request.reasoning_effort)).toEqual(['low', 'medium', 'high']);
        expect(captured.every((request) => request.model === 'same-upstream')).toBe(true);
      } finally {
        for (const server of [proxy, upstream])
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
      }
    },
  );
});
