import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createModelActions } from '../modelActions';
import { createModelManager } from '../modelManagement';
import type { CustomModel } from '../proxy';
import { runCustomModelRequest } from '../proxy/customRequest';
import { resolveConfiguredSubagentModel } from '../proxy/subagentModels';
import { subagentRouting } from '../proxy/subagentRouting';

const preload = ts.transpileModule(readFileSync(path.resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modelsUrl = 'http://localhost:50999/fetchAvailableModels';
const customModel = { name: 'example', displayName: 'Example', externalModelName: 'example-model' };

function createFixture(response: Response, models: unknown[] = [customModel], fireDomLoaded = true) {
  let onDomLoaded = () => {};
  const exposeInMainWorld = vi.fn();
  const vendorStorage = Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() });
  const nativeFetch = vi.fn().mockResolvedValue(response);
  const getModels = vi.fn().mockResolvedValue(models);
  const nativeOpen = vi.fn();
  const nativeSend = vi.fn();
  class TestXHR {
    readyState = 0;
    status = 0;
    responseType = '';
    contentType = 'application/json';
    responseText = '{"models":{"existing":{"displayName":"Existing"}}}';
    response: unknown = this.responseText;
    onreadystatechange: ((event: Event) => unknown) | null = null;
    onload: (() => void) | null = null;
    open(...args: unknown[]) {
      nativeOpen(...args);
    }
    send(...args: unknown[]) {
      nativeSend(...args);
    }
    getResponseHeader() {
      return this.contentType;
    }
    complete() {
      this.readyState = 4;
      this.status = 200;
      const result = this.onreadystatechange?.(new Event('readystatechange'));
      this.onload?.();
      return result;
    }
  }
  const window = {
    location: { href: 'http://localhost:54321/', pathname: '/', hash: '' },
    nativeStorage: vendorStorage,
    fetch: nativeFetch as typeof fetch,
    addEventListener: (name: string, callback: () => void) => {
      if (name === 'DOMContentLoaded') onDomLoaded = callback;
    },
  };
  runInNewContext(preload, {
    exports: {},
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Unexpected preload dependency: ${id}`);
      return {
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke: getModels },
        webFrame: {},
      };
    },
    window,
    document: { querySelectorAll: () => [], getElementById: () => null },
    location: window.location,
    setInterval: vi.fn(),
    XMLHttpRequest: TestXHR,
    URL,
    Headers,
    Request,
    Response,
    TextEncoder,
    TextDecoder,
    console,
  });
  if (fireDomLoaded) onDomLoaded();
  return {
    window,
    nativeFetch,
    getModels,
    TestXHR,
    nativeOpen,
    nativeSend,
    exposeInMainWorld,
    vendorStorage,
    fireDomLoaded: () => onDomLoaded(),
  };
}

describe('preload model-response compatibility', () => {
  it('runs with Electron alone and preserves APIs exposed by the vendor preload', () => {
    const fixture = createFixture(new Response());
    expect(fixture.exposeInMainWorld).not.toHaveBeenCalled();
    expect(fixture.window.nativeStorage).toBe(fixture.vendorStorage);
    expect(Object.keys(fixture.window.nativeStorage)).toEqual(['getItems', 'updateItems']);
  });

  it.each(['string', 'URL', 'Request'])('accepts %s fetch input and injects plain JSON model lists', async (kind) => {
    const original = new Response('{"models":{"existing":{"displayName":"Existing"}}}', {
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    });
    const fixture = createFixture(original);
    const input = kind === 'URL' ? new URL(modelsUrl) : kind === 'Request' ? new Request(modelsUrl) : modelsUrl;
    const result = await fixture.window.fetch(input);
    expect(fixture.nativeFetch).toHaveBeenCalledWith(input, undefined);
    expect(await result.json()).toMatchObject({
      models: { existing: { displayName: 'Existing' }, 'custom-example-model': { displayName: 'Example' } },
    });
    expect(original.bodyUsed).toBe(false);
  });

  it.each([
    'http://localhost:54321/exa.language_server_pb.LanguageServerService/GetAvailableModels',
    'http://localhost:54321/LanguageServerService/GetAvailableModels',
  ])('leaves RPC responses untouched even when labeled JSON: %s', async (url) => {
    const original = new Response('\0\0\0\0\x02{}', { headers: { 'content-type': 'application/json' } });
    const clone = vi.spyOn(original, 'clone');
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(url)).toBe(original);
    expect(clone).not.toHaveBeenCalled();
    expect(fixture.getModels).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });

  it.each(['application/connect+json', 'application/proto', 'application/json-seq', 'text/event-stream', ''])(
    'does not read, clone, or replace a %s response',
    async (contentType) => {
      const original = new Response('protocol frame', { headers: { 'content-type': contentType } });
      const clone = vi.spyOn(original, 'clone');
      const fixture = createFixture(original);
      expect(await fixture.window.fetch(modelsUrl)).toBe(original);
      expect(clone).not.toHaveBeenCalled();
      expect(fixture.getModels).not.toHaveBeenCalled();
      expect(original.bodyUsed).toBe(false);
    },
  );

  it('preserves invalid JSON and its unread original body', async () => {
    const original = new Response('not valid JSON', { headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(modelsUrl)).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(await original.text()).toBe('not valid JSON');
  });

  it('passes unrelated URLs and unsuccessful responses through', async () => {
    const original = new Response('forbidden', { status: 403, headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(modelsUrl)).toBe(original);
    expect(await fixture.window.fetch(new URL('http://localhost:54321/health'))).toBe(original);
    expect(fixture.getModels).not.toHaveBeenCalled();
  });

  it('preserves the fetch rejection when the request fails', async () => {
    const fixture = createFixture(new Response());
    const failure = new TypeError('Network request failed');
    fixture.nativeFetch.mockRejectedValue(failure);
    await expect(fixture.window.fetch(new URL(modelsUrl))).rejects.toBe(failure);
  });

  it('preserves omitted and explicit synchronous XHR open modes', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    xhr.open('GET', modelsUrl);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl, true, undefined, undefined);
    xhr.open('GET', modelsUrl, false);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl, false, undefined, undefined);
  });

  it('never replaces a Connect-RPC XHR event handler', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const onReady = vi.fn();
    xhr.onreadystatechange = onReady;
    xhr.open('POST', 'http://localhost:54321/exa.language_server_pb.LanguageServerService/GetAvailableModels');
    xhr.send();
    expect(xhr.onreadystatechange).toBe(onReady);
    expect(fixture.getModels).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: 'application/connect+json', responseType: '' },
    { contentType: 'text/event-stream', responseType: '' },
    { contentType: 'application/json', responseType: 'arraybuffer' },
    { contentType: 'application/json', responseType: 'json' },
  ])('does not read unsupported XHR responses and preserves native event order: %j', (options) => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    Object.assign(xhr, options);
    const readText = vi.fn(() => {
      throw new Error('Unsupported responseText access');
    });
    Object.defineProperty(xhr, 'responseText', { get: readText });
    const events: string[] = [];
    xhr.onreadystatechange = () => events.push('readystatechange');
    xhr.onload = () => events.push('load');
    xhr.open('GET', modelsUrl);
    xhr.send();
    expect(xhr.complete()).toBeUndefined();
    expect(events).toEqual(['readystatechange', 'load']);
    expect(readText).not.toHaveBeenCalled();
  });

  it('injects cached XHR JSON without delaying readystatechange behind load', async () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const events: string[] = [];
    xhr.onreadystatechange = () => events.push('readystatechange');
    xhr.onload = () => events.push('load');
    xhr.open('GET', modelsUrl);
    xhr.send();
    await new Promise((resolve) => setImmediate(resolve));
    xhr.complete();
    expect(JSON.parse(xhr.responseText)).toMatchObject({
      models: { existing: { displayName: 'Existing' }, 'custom-example-model': { displayName: 'Example' } },
    });
    expect(events).toEqual(['readystatechange', 'load']);
  });

  it('keeps synchronous XHR completion synchronous when the model cache is empty', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const original = xhr.responseText;
    const onReady = vi.fn();
    xhr.onreadystatechange = onReady;
    xhr.open('GET', modelsUrl, false);
    xhr.send();
    expect(xhr.complete()).toBeUndefined();
    expect(onReady).toHaveBeenCalledOnce();
    expect(fixture.getModels).not.toHaveBeenCalled();
    expect(xhr.responseText).toBe(original);
  });

  it.each(['fetch', 'xhr'])('preserves authoritative proxy effort variants without duplicate injection through %s', async (transport) => {
    const models = ['low', 'medium', 'high'].map((effort, index) => ({
      ...customModel, name: `models/effort-${effort}`, displayName: `Example ${effort}`,
      nativeCatalogId: `custom-effort-${effort}-identity`, nativeModelId: `MODEL_PLACEHOLDER_M${30 + index}`,
      nativePickerAvailable: true,
    }));
    const catalog = { models: Object.fromEntries(models.map((model) => [model.nativeCatalogId, {
      displayName: model.displayName, model: model.nativeModelId,
      supportsImages: true, maxTokens: 32000, quotaInfo: { remainingFraction: 0.25 },
    }])) };
    const responseText = JSON.stringify(catalog);
    const original = new Response(responseText, { headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original, models);
    if (transport === 'fetch') {
      const response = await fixture.window.fetch(modelsUrl);
      expect(response).toBe(original);
      expect(await response.json()).toEqual(catalog);
    } else {
      const xhr = new fixture.TestXHR();
      xhr.responseText = responseText;
      xhr.open('GET', modelsUrl);
      xhr.send();
      await new Promise((resolve) => setImmediate(resolve));
      xhr.complete();
      expect(xhr.responseText).toBe(responseText);
    }
  });

  it('uses IPC-assigned identities and never guesses for an unavailable native picker slot', async () => {
    const fixture = createFixture(new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } }), [
      { ...customModel, nativeCatalogId: 'custom-assigned-id', nativeModelId: 'MODEL_PLACEHOLDER_M640', nativePickerAvailable: true },
      { ...customModel, name: 'overflow', nativeCatalogId: 'custom-overflow', nativePickerAvailable: false },
    ]);
    const result = await (await fixture.window.fetch(modelsUrl)).json();
    expect(Object.keys(result.models)).toEqual(['custom-assigned-id']);
    expect(result.models['custom-assigned-id'].model).toBe('MODEL_PLACEHOLDER_M640');
  });

  it.each(['fetch', 'xhr'])('preserves calculated checkpoint policy and real model limits in %s fallback', async (transport) => {
    const nativeModelExperiments = {
      experiments: { CASCADE_USE_EXPERIMENT_CHECKPOINTER: { stringValue: JSON.stringify({
        useLastPlannerModel: true, maxOutputTokens: 8192, maxTokenLimit: 75784, tokenThreshold: 68000,
      }) } },
    };
    const fixture = createFixture(new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } }), [{
      ...customModel, nativeCatalogId: 'custom-threshold', nativeModelId: 'MODEL_PLACEHOLDER_M640',
      nativePickerAvailable: true, contextWindow: 85000, nativeContextWindow: 90000, nativeMaxOutputTokens: 8192,
      nativeModelExperiments,
    }]);
    let result: any;
    if (transport === 'fetch') result = await (await fixture.window.fetch(modelsUrl)).json();
    else {
      const xhr = new fixture.TestXHR();
      xhr.open('GET', modelsUrl);
      xhr.send();
      await new Promise((resolve) => setImmediate(resolve));
      xhr.complete();
      result = JSON.parse(xhr.responseText);
    }
    expect(result.models['custom-threshold']).toMatchObject({
      maxTokens: 90000, maxOutputTokens: 8192, modelExperiments: nativeModelExperiments,
    });
  });

  it('does not invent a shared legacy alias for older IPC effort variants', async () => {
    const original = new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original, [customModel, { ...customModel, name: 'another-effort' }]);
    expect(await fixture.window.fetch(modelsUrl)).toBe(original);
  });

  it('disambiguates labels in plain JSON fallback while preserving native and already-injected entries', async () => {
    const native = { displayName: 'Example', model: 'NATIVE_MODEL' };
    const fixture = createFixture(new Response(JSON.stringify({ models: { native } }), { headers: { 'content-type': 'application/json' } }), [
      { ...customModel, name: 'models/one', nativeCatalogId: 'custom-one', nativeModelId: 'MODEL_PLACEHOLDER_M640', nativePickerAvailable: true },
      { ...customModel, name: 'models/two', nativeCatalogId: 'custom-two', nativeModelId: 'MODEL_PLACEHOLDER_M641', nativePickerAvailable: true },
    ]);
    const result = await (await fixture.window.fetch(modelsUrl)).json();
    expect(result.models.native).toEqual(native);
    expect(new Set(Object.values(result.models).map((entry: any) => entry.displayName)).size).toBe(3);
  });

  function encodeGrpcWebFrames(frames: Array<{ flag: number; payload: Uint8Array }>): Uint8Array {
    const total = frames.reduce((sum, frame) => sum + 5 + frame.payload.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const frame of frames) {
      out[offset] = frame.flag;
      view.setUint32(offset + 1, frame.payload.length, false);
      out.set(frame.payload, offset + 5);
      offset += 5 + frame.payload.length;
    }
    return out;
  }

  function decodeGrpcWebFrames(bytes: Uint8Array): Array<{ flag: number; payload: Uint8Array }> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: Array<{ flag: number; payload: Uint8Array }> = [];
    let offset = 0;
    while (offset < bytes.length) {
      const flag = bytes[offset];
      const len = view.getUint32(offset + 1, false);
      frames.push({ flag, payload: bytes.slice(offset + 5, offset + 5 + len) });
      offset += 5 + len;
    }
    return frames;
  }

  it('appends custom base slugs to orchestrator-model-roles in gRPC-Web JSON GetMendelFlags responses and preserves trailers', async () => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const trailerText = 'grpc-status: 0\r\n';
    const rolesJson = JSON.stringify({ orchestrators: ['gemini-4-neon'], executors: ['gemini-4-hydrogen'] });
    const flagBody = JSON.stringify({
      experimentConfig: {
        experiments: [
          { keyString: 'enable-orchestrator-model-selection', boolValue: true },
          { keyString: 'orchestrator-model-roles', string: rolesJson },
        ],
      },
    });
    const encoder = new TextEncoder();
    const rawBytes = encodeGrpcWebFrames([
      { flag: 0x00, payload: encoder.encode(flagBody) },
      { flag: 0x80, payload: encoder.encode(trailerText) },
    ]);
    const original = new Response(rawBytes, {
      headers: {
        'content-type': 'application/grpc-web+json',
        'content-length': String(rawBytes.length),
      },
    });
    const models = [
      {
        name: 'models/custom/deepseek-v4.1-flash',
        displayName: 'DeepSeek V4.1 Flash',
        externalModelName: 'deepseek-v4.1-flash',
        nativeCatalogId: 'custom-deepseek-v4-1-flash',
        nativeModelId: 'MODEL_PLACEHOLDER_M588',
        nativePickerAvailable: true,
      },
      {
        name: 'models/custom/qwen-high',
        displayName: 'Qwen High',
        externalModelName: 'qwen-high',
        nativeCatalogId: 'custom-qwen-high',
        nativeModelId: 'MODEL_PLACEHOLDER_M589',
        nativePickerAvailable: true,
      },
      {
        name: 'models/custom/qwen-xhigh',
        displayName: 'Qwen XHigh',
        externalModelName: 'qwen-xhigh',
        nativeCatalogId: 'custom-qwen-xhigh',
        nativeModelId: 'MODEL_PLACEHOLDER_M590',
        nativePickerAvailable: true,
      },
      {
        name: 'models/custom/disabled-slot',
        displayName: 'Disabled Slot',
        externalModelName: 'disabled-slot',
        nativeCatalogId: 'custom-disabled',
        nativePickerAvailable: false,
      },
    ];
    const fixture = createFixture(original, models);
    const res = await fixture.window.fetch(mendelUrl);
    expect(res).not.toBe(original);
    expect(res.headers.get('content-length')).toBeNull();

    const outFrames = decodeGrpcWebFrames(new Uint8Array(await res.arrayBuffer()));
    expect(outFrames).toHaveLength(2);
    expect(outFrames[0].flag).toBe(0x00);
    const decodedBody = JSON.parse(new TextDecoder().decode(outFrames[0].payload));
    const rolesEntry = decodedBody.experimentConfig.experiments.find(
      (entry: Record<string, unknown>) => entry.keyString === 'orchestrator-model-roles',
    );
    expect(JSON.parse(rolesEntry.string)).toEqual({
      orchestrators: ['gemini-4-neon', 'custom-deepseek-v4-1-flash', 'custom-qwen'],
      executors: ['gemini-4-hydrogen', 'custom-deepseek-v4-1-flash', 'custom-qwen'],
    });
    expect(outFrames[1].flag).toBe(0x80);
    expect(new TextDecoder().decode(outFrames[1].payload)).toBe(trailerText);

    // Idempotent when run a second time on the already-injected payload
    const secondInput = encodeGrpcWebFrames(outFrames);
    const secondOrig = new Response(secondInput, {
      headers: { 'content-type': 'application/grpc-web+json' },
    });
    fixture.nativeFetch.mockResolvedValueOnce(secondOrig);
    const secondRes = await fixture.window.fetch(mendelUrl);
    expect(secondRes).toBe(secondOrig);
    expect(secondOrig.bodyUsed).toBe(false);
  });

  it.each([
    { field: 'string', build: (v: string) => ({ keyString: 'orchestrator-model-roles', string: v }) },
    { field: 'payload', build: (v: string) => ({ keyString: 'orchestrator-model-roles', payload: { case: 'string', value: v } }) },
  ])('injects custom slugs into plain JSON GetMendelFlags responses (%s)', async ({ field, build }) => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const rolesJson = JSON.stringify({ orchestrators: ['gemini-4-neon'], executors: ['gemini-4-hydrogen'] });
    const body = JSON.stringify({ experimentConfig: { experiments: [build(rolesJson)] } });
    const original = new Response(body, { headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original, [
      {
        name: 'models/deepseek-v4.1-flash',
        displayName: 'DeepSeek V4.1 Flash',
        externalModelName: 'deepseek-v4.1-flash',
        nativeCatalogId: 'custom-deepseek-v4-1-flash',
        nativeModelId: 'MODEL_PLACEHOLDER_M588',
        nativePickerAvailable: true,
      },
    ]);
    const res = await fixture.window.fetch(mendelUrl);
    const parsed = await res.json();
    const entry = parsed.experimentConfig.experiments[0];
    const updatedRoles = JSON.parse(field === 'payload' ? entry.payload.value : entry.string);
    expect(updatedRoles).toEqual({
      orchestrators: ['gemini-4-neon', 'custom-deepseek-v4-1-flash'],
      executors: ['gemini-4-hydrogen', 'custom-deepseek-v4-1-flash'],
    });
  });

  it('leaves unrelated gRPC-Web LanguageServerService RPCs untouched', async () => {
    const otherRpcUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/Heartbeat';
    const raw = encodeGrpcWebFrames([
      { flag: 0x00, payload: new TextEncoder().encode(JSON.stringify({ ok: true })) },
    ]);
    const original = new Response(raw, { headers: { 'content-type': 'application/grpc-web+json' } });
    const clone = vi.spyOn(original, 'clone');
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(otherRpcUrl)).toBe(original);
    expect(clone).not.toHaveBeenCalled();
    expect(fixture.getModels).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });

  it('intercepts GetMendelFlags before DOMContentLoaded fires during initial /main.js evaluation', async () => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const rolesJson = JSON.stringify({ orchestrators: ['gemini-4-neon'], executors: ['gemini-4-hydrogen'] });
    const raw = encodeGrpcWebFrames([
      {
        flag: 0x00,
        payload: new TextEncoder().encode(
          JSON.stringify({
            experimentConfig: {
              experiments: [{ keyString: 'orchestrator-model-roles', string: rolesJson }],
            },
          }),
        ),
      },
    ]);
    const original = new Response(raw, { headers: { 'content-type': 'application/grpc-web+json' } });
    const fixture = createFixture(
      original,
      [
        {
          name: 'models/deepseek-v4.1-flash',
          displayName: 'DeepSeek V4.1 Flash',
          externalModelName: 'deepseek-v4.1-flash',
          nativeCatalogId: 'custom-deepseek-v4-1-flash',
          nativeModelId: 'MODEL_PLACEHOLDER_M588',
          nativePickerAvailable: true,
        },
      ],
      false, // Do NOT fire DOMContentLoaded before calling fetch
    );
    const res = await fixture.window.fetch(mendelUrl);
    const frames = decodeGrpcWebFrames(new Uint8Array(await res.arrayBuffer()));
    const decoded = JSON.parse(new TextDecoder().decode(frames[0].payload));
    expect(JSON.parse(decoded.experimentConfig.experiments[0].string)).toEqual({
      orchestrators: ['gemini-4-neon', 'custom-deepseek-v4-1-flash'],
      executors: ['gemini-4-hydrogen', 'custom-deepseek-v4-1-flash'],
    });
  });

  it('normalizes GetUserStatus clientModelConfigs order (built-in Gemini first, custom models in JSON order) and falls back missing displayName to model ID', async () => {
    const userStatusUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetUserStatus';
    // Simulate Go map randomized iteration order where custom-b came before gemini-4-neon and custom-a had no label
    const payload = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Custom B',
              modelId: 'custom-model-b',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M502' },
            },
            {
              label: 'Gemini 4 Neon (High)',
              modelId: 'gemini-4-neon-high',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
            },
            {
              label: '',
              modelId: 'custom-deepseek-v4-1-flash',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M501' },
            },
            {
              label: 'Gemini 4 Hydrogen',
              modelId: 'gemini-4-hydrogen',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M18' },
            },
          ],
        },
      },
    };
    const raw = encodeGrpcWebFrames([
      { flag: 0x00, payload: new TextEncoder().encode(JSON.stringify(payload)) },
      { flag: 0x80, payload: new TextEncoder().encode('grpc-status: 0\r\n') },
    ]);
    const original = new Response(raw, { headers: { 'content-type': 'application/grpc-web+json' } });
    const models = [
      {
        name: 'models/deepseek-v4.1-flash',
        // displayName intentionally omitted to test fallback to ID
        externalModelName: 'deepseek-v4.1-flash',
        provider: 'custom',
        apiFormat: 'openai',
        apiUrl: 'https://api.zero-ai.cc/gpt/v1/chat/completions',
        rawUrl: true,
        enabled: true,
        contextWindow: 1048576,
        nativeCatalogId: 'custom-deepseek-v4-1-flash',
        nativeModelId: 'MODEL_PLACEHOLDER_M501',
        nativePickerAvailable: true,
      },
      // Duplicate ID in JSON must be ignored without shifting order
      {
        name: 'models/deepseek-v4.1-flash',
        displayName: 'Duplicate Should Be Ignored',
        externalModelName: 'deepseek-v4.1-flash',
        enabled: true,
        nativeCatalogId: 'custom-deepseek-v4-1-flash',
        nativeModelId: 'MODEL_PLACEHOLDER_M501',
        nativePickerAvailable: true,
      },
      {
        name: 'models/model-b',
        displayName: 'Custom B',
        externalModelName: 'model-b',
        provider: 'anthropic',
        apiFormat: 'anthropic',
        apiUrl: 'https://api.anthropic.example/v1/messages',
        enabled: true,
        nativeCatalogId: 'custom-model-b',
        nativeModelId: 'MODEL_PLACEHOLDER_M502',
        nativePickerAvailable: true,
      },
      {
        name: 'models/disabled-c',
        displayName: 'Disabled C',
        externalModelName: 'disabled-c',
        enabled: false,
        nativeCatalogId: 'custom-disabled-c',
        nativeModelId: 'MODEL_PLACEHOLDER_M503',
        nativePickerAvailable: true,
      },
    ];
    const fixture = createFixture(original, models);
    const res = await fixture.window.fetch(userStatusUrl);
    const frames = decodeGrpcWebFrames(new Uint8Array(await res.arrayBuffer()));
    const decoded = JSON.parse(new TextDecoder().decode(frames[0].payload));
    const configs = decoded.userStatus.cascadeModelConfigData.clientModelConfigs;
    expect(configs.map((c: Record<string, unknown>) => ({ modelId: c.modelId, label: c.label }))).toEqual([
      { modelId: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { modelId: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
      { modelId: 'custom-deepseek-v4-1-flash', label: 'deepseek-v4.1-flash' },
      { modelId: 'custom-model-b', label: 'Custom B' },
    ]);
  });

  it('handles empty or failed storage:get-custom-models gracefully without crashing GetMendelFlags or GetAvailableModels', async () => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const rolesJson = JSON.stringify({ orchestrators: ['gemini-4-neon'], executors: ['gemini-4-hydrogen'] });
    const raw = encodeGrpcWebFrames([
      {
        flag: 0x00,
        payload: new TextEncoder().encode(
          JSON.stringify({
            experimentConfig: {
              experiments: [{ keyString: 'orchestrator-model-roles', string: rolesJson }],
            },
          }),
        ),
      },
    ]);
    const original = new Response(raw, { headers: { 'content-type': 'application/grpc-web+json' } });
    const fixture = createFixture(original, []);
    fixture.getModels.mockRejectedValueOnce(new Error('Invalid JSON in custom_models.json'));
    const res = await fixture.window.fetch(mendelUrl);
    expect(res).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it('orders custom models by configIndex (JSON order) even when storage:get-custom-models returns recency order', async () => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const userStatusUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetUserStatus';
    const modelsInRecencyOrder = [
      {
        name: 'models/second-in-json',
        displayName: 'Second In JSON',
        externalModelName: 'second-in-json',
        configIndex: 1,
        enabled: true,
        nativeCatalogId: 'custom-second-in-json',
        nativeModelId: 'MODEL_PLACEHOLDER_M512',
        nativePickerAvailable: true,
      },
      {
        name: 'models/first-in-json',
        displayName: 'First In JSON',
        externalModelName: 'first-in-json',
        configIndex: 0,
        enabled: true,
        nativeCatalogId: 'custom-first-in-json',
        nativeModelId: 'MODEL_PLACEHOLDER_M511',
        nativePickerAvailable: true,
      },
    ];

    const mendelOriginal = new Response(
      JSON.stringify({
        experimentConfig: {
          experiments: [
            {
              keyString: 'orchestrator-model-roles',
              string: JSON.stringify({ orchestrators: ['gemini-4-neon'], executors: ['gemini-4-hydrogen'] }),
            },
          ],
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const fixture = createFixture(mendelOriginal, modelsInRecencyOrder);
    const patchedMendel = await (await fixture.window.fetch(mendelUrl)).json();
    expect(JSON.parse(patchedMendel.experimentConfig.experiments[0].string)).toEqual({
      orchestrators: ['gemini-4-neon', 'custom-first-in-json', 'custom-second-in-json'],
      executors: ['gemini-4-hydrogen', 'custom-first-in-json', 'custom-second-in-json'],
    });

    fixture.nativeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Second In JSON',
                  modelId: 'custom-second-in-json',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M512' },
                },
                {
                  label: 'Gemini 4 Neon',
                  modelId: 'gemini-4-neon',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
                },
                {
                  label: 'First In JSON',
                  modelId: 'custom-first-in-json',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M511' },
                },
              ],
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const patchedStatus = await (await fixture.window.fetch(userStatusUrl)).json();
    expect(
      patchedStatus.userStatus.cascadeModelConfigData.clientModelConfigs.map((c: Record<string, unknown>) => c.modelId),
    ).toEqual(['gemini-4-neon', 'custom-first-in-json', 'custom-second-in-json']);
  });

  it('intercepts GetMendelFlags and GetUserStatus in an isolated main world via webFrame.executeJavaScript + postMessage without leaking secrets', async () => {
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const userStatusUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetUserStatus';
    let currentModels = [
      {
        name: 'models/model-b',
        displayName: 'Model B',
        externalModelName: 'model-b',
        apiKey: 'secret-key-b',
        apiUrl: 'https://secret-b.example/v1',
        customHeaders: { Authorization: 'Bearer secret-b' },
        configIndex: 1,
        enabled: true,
        nativeCatalogId: 'custom-model-b',
        nativeModelId: 'MODEL_PLACEHOLDER_M522',
        nativePickerAvailable: true,
      },
      {
        name: 'models/model-a',
        externalModelName: 'model-a',
        apiKey: 'secret-key-a',
        apiUrl: 'https://secret-a.example/v1',
        configIndex: 0,
        enabled: true,
        nativeCatalogId: 'custom-model-a',
        nativeModelId: 'MODEL_PLACEHOLDER_M521',
        nativePickerAvailable: true,
      },
      {
        name: 'models/model-disabled',
        displayName: 'Disabled',
        externalModelName: 'model-disabled',
        configIndex: 2,
        enabled: false,
        nativeCatalogId: 'custom-model-disabled',
        nativeModelId: 'MODEL_PLACEHOLDER_M523',
        nativePickerAvailable: true,
      },
    ];

    const preloadListeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
    const mainListeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
    const postedPayloads: unknown[] = [];

    const mainFetch = vi.fn();
    const mainWorldWindow: Record<string, unknown> = {
      fetch: mainFetch,
      addEventListener: (type: string, fn: (ev: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') mainListeners.push(fn);
      },
      removeEventListener: (type: string, fn: (ev: { source: unknown; data: unknown }) => void) => {
        if (type !== 'message') return;
        const i = mainListeners.indexOf(fn);
        if (i >= 0) mainListeners.splice(i, 1);
      },
    };
    const preloadWindow: Record<string, unknown> = {
      location: { href: 'http://localhost:54321/', pathname: '/', hash: '' },
      nativeStorage: Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() }),
      fetch: vi.fn(), // isolated preload fetch should NOT be called by main-world ls_web/main.js
      addEventListener: (type: string, fn: (ev: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') preloadListeners.push(fn);
      },
    };
    const dispatchMessage = (data: unknown) => {
      postedPayloads.push(data);
      queueMicrotask(() => {
        for (const fn of [...preloadListeners]) fn({ source: preloadWindow, data });
        for (const fn of [...mainListeners]) fn({ source: mainWorldWindow, data });
      });
    };
    preloadWindow.postMessage = (data: unknown) => {
      postedPayloads.push(data);
      queueMicrotask(() => {
        for (const fn of [...mainListeners]) fn({ source: mainWorldWindow, data });
      });
    };
    mainWorldWindow.postMessage = (data: unknown) => {
      postedPayloads.push(data);
      queueMicrotask(() => {
        for (const fn of [...preloadListeners]) fn({ source: preloadWindow, data });
      });
    };
    void dispatchMessage;

    const executedScripts: string[] = [];
    runInNewContext(preload, {
      exports: {},
      require: (id: string) => {
        if (id !== 'electron') throw new Error(`Unexpected preload dependency: ${id}`);
        return {
          contextBridge: { exposeInMainWorld: vi.fn() },
          ipcRenderer: { invoke: vi.fn().mockImplementation(async () => currentModels) },
          webFrame: {
            executeJavaScript: async (code: string) => {
              executedScripts.push(code);
              runInNewContext(code, {
                window: mainWorldWindow,
                Response,
                Headers,
                TextEncoder,
                TextDecoder,
                setTimeout,
                clearTimeout,
                Date,
              });
            },
          },
        };
      },
      window: preloadWindow,
      document: { querySelectorAll: () => [], getElementById: () => null },
      location: preloadWindow.location,
      setInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      URL,
      Headers,
      Request,
      Response,
      TextEncoder,
      TextDecoder,
      console,
    });

    expect(executedScripts).toHaveLength(1);
    expect(mainWorldWindow.fetch).not.toBe(mainFetch);

    const trailerText = 'grpc-status: 0\r\n';
    const encoder = new TextEncoder();
    mainFetch.mockResolvedValueOnce(
      new Response(
        encodeGrpcWebFrames([
          {
            flag: 0x00,
            payload: encoder.encode(
              JSON.stringify({
                experimentConfig: {
                  experiments: [
                    {
                      keyString: 'orchestrator-model-roles',
                      string: JSON.stringify({
                        orchestrators: ['gemini-4-neon', 'claude-opus-5-5'],
                        executors: ['gemini-4-hydrogen', 'claude-sonnet-5-5'],
                      }),
                    },
                  ],
                },
              }),
            ),
          },
          { flag: 0x80, payload: encoder.encode(trailerText) },
        ]),
        { headers: { 'content-type': 'application/grpc-web+json', 'content-length': '999' } },
      ),
    );

    const mendelRes = await (mainWorldWindow.fetch as typeof fetch)(mendelUrl);
    const outFrames = decodeGrpcWebFrames(new Uint8Array(await mendelRes.arrayBuffer()));
    expect(outFrames).toHaveLength(2);
    expect(new TextDecoder().decode(outFrames[1].payload)).toBe(trailerText);
    const mendelParsed = JSON.parse(new TextDecoder().decode(outFrames[0].payload));
    expect(JSON.parse(mendelParsed.experimentConfig.experiments[0].string)).toEqual({
      orchestrators: ['gemini-4-neon', 'claude-opus-5-5', 'custom-model-a', 'custom-model-b'],
      executors: ['gemini-4-hydrogen', 'claude-sonnet-5-5', 'custom-model-a', 'custom-model-b'],
    });

    mainFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: 'Model B', modelId: 'custom-model-b', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M522' } },
                { label: 'Gemini 4 Neon', modelId: 'gemini-4-neon', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' } },
                { label: '', modelId: 'custom-model-a', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M521' } },
              ],
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const statusRes = await (mainWorldWindow.fetch as typeof fetch)(userStatusUrl);
    const statusParsed = await statusRes.json();
    expect(
      statusParsed.userStatus.cascadeModelConfigData.clientModelConfigs.map((c: Record<string, unknown>) => ({
        modelId: c.modelId,
        label: c.label,
      })),
    ).toEqual([
      { modelId: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { modelId: 'custom-model-a', label: 'model-a' },
      { modelId: 'custom-model-b', label: 'Model B' },
    ]);

    const serializedBridge = JSON.stringify(postedPayloads);
    expect(serializedBridge).not.toContain('secret-key-a');
    expect(serializedBridge).not.toContain('secret-key-b');
    expect(serializedBridge).not.toContain('secret-a.example');
    expect(serializedBridge).not.toContain('secret-b.example');
    expect(serializedBridge).not.toContain('Authorization');
  });
});

describe('orchestrator and executor custom models end-to-end verification', () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    subagentRouting.clear();
    for (const srv of servers.splice(0)) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Exact replica of the renderer's oW / mW / pW / lSb dropdown & fallback logic from ls_web/main.js
  const EFFORT_RE = /-(low|medium|high|xhigh|max)$/;
  interface ClientModelOption {
    label: string;
    value: number;
    modelId?: string;
    disabled?: boolean;
    isCustom?: boolean;
  }
  interface MendelRoles {
    orchestrators: string[];
    executors: string[];
  }
  interface GroupedModelFamily {
    displayName: string;
    supportedThinkingLevels: number[];
  }
  function filterOptionsForRole(
    options: ClientModelOption[],
    role: 'orchestrator' | 'executor',
    roles: MendelRoles,
  ): ClientModelOption[] {
    const allowed = new Set(role === 'orchestrator' ? roles.orchestrators : roles.executors);
    return options.filter(
      (opt) =>
        !opt.disabled &&
        !opt.isCustom &&
        opt.value !== 0 &&
        opt.modelId !== undefined &&
        allowed.has(opt.modelId.replace(EFFORT_RE, '')),
    );
  }
  function buildDropdownRows(
    filtered: ClientModelOption[],
    groupedModels: Record<number, GroupedModelFamily>,
  ): Array<{ kind: 'family'; displayName: string; tiers: number[] } | { kind: 'model'; option: ClientModelOption }> {
    const rows: Array<
      { kind: 'family'; displayName: string; tiers: number[] } | { kind: 'model'; option: ClientModelOption }
    > = [];
    const seenFamilies = new Set<number>();
    for (const opt of filtered) {
      let matchedFamilyKey: number | undefined;
      for (const [keyStr, group] of Object.entries(groupedModels)) {
        if (group.supportedThinkingLevels.includes(opt.value)) {
          matchedFamilyKey = Number(keyStr);
          break;
        }
      }
      if (matchedFamilyKey !== undefined) {
        if (seenFamilies.has(matchedFamilyKey)) continue;
        seenFamilies.add(matchedFamilyKey);
        const fam = groupedModels[matchedFamilyKey];
        const availableTiers = fam.supportedThinkingLevels.filter((v) => filtered.some((o) => o.value === v));
        if (availableTiers.length > 1) {
          rows.push({ kind: 'family', displayName: fam.displayName, tiers: availableTiers });
        } else {
          rows.push({ kind: 'model', option: opt });
        }
      } else {
        rows.push({ kind: 'model', option: opt });
      }
    }
    return rows;
  }
  function resolveDefaultOption(
    filtered: ClientModelOption[],
    role: 'orchestrator' | 'executor',
    roles: MendelRoles,
  ): ClientModelOption | undefined {
    for (const slug of role === 'orchestrator' ? roles.orchestrators : roles.executors) {
      const hit = filtered.find((opt) => opt.modelId !== undefined && opt.modelId.replace(EFFORT_RE, '') === slug);
      if (hit !== undefined) return hit;
    }
    return filtered[0];
  }
  function resolveActiveSelection(
    filtered: ClientModelOption[],
    persistedValue: number,
    role: 'orchestrator' | 'executor',
    roles: MendelRoles,
  ): { displayed: ClientModelOption | undefined; runtimeValue: number } {
    const fallback = resolveDefaultOption(filtered, role, roles);
    const matched = persistedValue === 0 ? undefined : filtered.find((opt) => opt.value === persistedValue);
    return {
      displayed: matched ?? fallback,
      runtimeValue: matched ? persistedValue : 0, // 0 = F.Model.UNSPECIFIED -> falls back to default Gemini model
    };
  }

  it('dynamically populates both dropdowns from custom_models.json (3+ models, edge cases, persistence, fallback on removal, and isolated two-model orchestrator/executor endpoint routing)', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'agy-orch-e2e-'));
    tempDirs.push(dataDir);

    const orchRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const execRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

    // Endpoint 1: Orchestrator custom model endpoint (OpenAI-compatible rawUrl, e.g. ZERO-AI shape)
    const orchServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        orchRequests.push({ url: req.url || '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-orch-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_exec_1',
                      type: 'function',
                      function: {
                        name: 'invoke_subagent',
                        arguments: JSON.stringify({
                          Subagents: [{ Prompt: 'Execute implementation step via executor model', TypeName: 'coding' }],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 25, completion_tokens: 18, total_tokens: 43 },
          }),
        );
      });
    });
    servers.push(orchServer);
    await new Promise<void>((resolve) => orchServer.listen(0, '127.0.0.1', resolve));
    const orchPort = (orchServer.address() as { port: number }).port;
    const orchEndpoint = `http://127.0.0.1:${orchPort}/gpt/v1/chat/completions`;

    // Endpoint 2: Executor custom model endpoint (Anthropic format on separate server)
    const execServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        execRequests.push({ url: req.url || '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg-exec-1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'EXECUTOR COMPLETED TASK ON ENDPOINT 2' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 30, output_tokens: 12 },
          }),
        );
      });
    });
    servers.push(execServer);
    await new Promise<void>((resolve) => execServer.listen(0, '127.0.0.1', resolve));
    const execPort = (execServer.address() as { port: number }).port;
    const execEndpoint = `http://127.0.0.1:${execPort}/v1/messages`;

    // Write custom_models.json with:
    // 1. Enabled custom model 1 (no displayName -> falls back to id; rawUrl: true; custom provider; 1M contextWindow)
    // 2. Duplicate ID entry (must be deduplicated without crashing)
    // 3. Enabled custom model 2 (different provider/apiFormat/apiUrl/contextWindow)
    // 4. Disabled custom model 3 (enabled: false -> must NOT appear in either dropdown)
    const manager = createModelManager(
      dataDir,
      { encryptString: (v: string) => v, decryptString: (v: string) => v },
      async () => {},
    );
    writeFileSync(
      path.join(dataDir, 'custom_models.json'),
      JSON.stringify(
        {
          models: [
            {
              name: 'models/deepseek-v4.1-flash',
              // displayName omitted to verify fallback to ID
              provider: 'custom',
              apiFormat: 'openai',
              apiUrl: orchEndpoint,
              rawUrl: true,
              apiKey: 'test-key-1',
              externalModelName: 'deepseek-v4.1-flash',
              enabled: true,
              contextWindow: 1048576,
            },
            {
              name: 'models/deepseek-v4.1-flash',
              displayName: 'Duplicate Entry Should Be Ignored',
              provider: 'custom',
              apiFormat: 'openai',
              apiUrl: orchEndpoint,
              apiKey: 'test-key-dup',
              externalModelName: 'deepseek-v4.1-flash',
              enabled: true,
            },
            {
              name: 'models/zero-ai-executor-sonnet',
              displayName: 'Zero-AI Executor Sonnet',
              provider: 'anthropic',
              apiFormat: 'anthropic',
              apiUrl: execEndpoint,
              rawUrl: true,
              apiKey: 'test-key-2',
              externalModelName: 'claude-sonnet-4-6',
              enabled: true,
              contextWindow: 200000,
            },
            {
              name: 'models/disabled-custom-model',
              displayName: 'Disabled Custom Model',
              provider: 'openai',
              apiFormat: 'openai',
              apiUrl: 'http://127.0.0.1:9/unused',
              apiKey: 'test-key-3',
              externalModelName: 'disabled-custom-model',
              enabled: false,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const actions = createModelActions(manager);
    const ipcModels = await actions['storage:get-custom-models']();
    const enabledIpcModels = ipcModels.filter((m) => m.enabled !== false && m.nativePickerAvailable !== false);
    expect(enabledIpcModels).toHaveLength(2);
    expect(enabledIpcModels.map((m) => m.name)).toEqual([
      'models/deepseek-v4.1-flash',
      'models/zero-ai-executor-sonnet',
    ]);

    // Verify GetMendelFlags + GetUserStatus through customPreload
    const mendelUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetMendelFlags';
    const userStatusUrl = 'https://127.0.0.1:54321/exa.language_server_pb.LanguageServerService/GetUserStatus';
    const baseRoles: MendelRoles = {
      orchestrators: ['gemini-4-neon', 'gemini-4-hydrogen'],
      executors: ['gemini-4-neon', 'gemini-4-hydrogen'],
    };
    const mendelResponse = new Response(
      JSON.stringify({
        experimentConfig: {
          experiments: [{ keyString: 'orchestrator-model-roles', string: JSON.stringify(baseRoles) }],
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

    const fixture = createFixture(mendelResponse, ipcModels);
    const patchedMendel = await (await fixture.window.fetch(mendelUrl)).json();
    const patchedRoles: MendelRoles = JSON.parse(patchedMendel.experimentConfig.experiments[0].string);

    // Both enabled custom models appear in orchestrators and executors; disabled model does NOT
    expect(patchedRoles.orchestrators).toEqual([
      'gemini-4-neon',
      'gemini-4-hydrogen',
      'custom-deepseek-v4-1-flash',
      'custom-claude-sonnet-4-6',
    ]);
    expect(patchedRoles.executors).toEqual([
      'gemini-4-neon',
      'gemini-4-hydrogen',
      'custom-deepseek-v4-1-flash',
      'custom-claude-sonnet-4-6',
    ]);
    expect(patchedRoles.orchestrators).not.toContain('custom-disabled-custom-model');
    expect(patchedRoles.executors).not.toContain('custom-disabled-custom-model');

    // Simulate GetUserStatus with built-in Gemini 4 models (with effort levels) + custom models out of order
    const m1Val = Number(enabledIpcModels[0].nativeModelId!.replace('MODEL_PLACEHOLDER_M', '')) + 1000;
    const m2Val = Number(enabledIpcModels[1].nativeModelId!.replace('MODEL_PLACEHOLDER_M', '')) + 1000;
    const userStatusBody = {
      userStatus: {
        cascadeModelConfigData: {
          groupedModels: {
            429: { displayName: 'Gemini 4 Neon', supportedThinkingLevels: [376, 377, 429] },
          },
          clientModelConfigs: [
            // Intentionally put custom model 2 first to verify normalization puts Gemini first then custom in JSON order
            {
              label: enabledIpcModels[1].displayName,
              modelId: enabledIpcModels[1].nativeCatalogId,
              modelOrAlias: { model: enabledIpcModels[1].nativeModelId },
            },
            {
              label: 'Gemini 4 Neon (Medium)',
              modelId: 'gemini-4-neon-medium',
              modelOrAlias: { choice: { case: 'model', value: 377 } },
            },
            {
              label: 'Gemini 4 Neon (High)',
              modelId: 'gemini-4-neon-high',
              modelOrAlias: { choice: { case: 'model', value: 429 } },
            },
            {
              label: '', // Missing displayName falls back to ID
              modelId: enabledIpcModels[0].nativeCatalogId,
              modelOrAlias: { model: enabledIpcModels[0].nativeModelId },
            },
            {
              label: 'Gemini 4 Hydrogen',
              modelId: 'gemini-4-hydrogen',
              modelOrAlias: { choice: { case: 'model', value: 456 } },
            },
          ],
        },
      },
    };
    fixture.nativeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(userStatusBody), { headers: { 'content-type': 'application/json' } }),
    );
    const patchedStatus = await (await fixture.window.fetch(userStatusUrl)).json();
    const rawConfigs = patchedStatus.userStatus.cascadeModelConfigData.clientModelConfigs;
    const clientOptions: ClientModelOption[] = rawConfigs.map((cfg: Record<string, any>) => ({
      label: cfg.label,
      modelId: cfg.modelId,
      value:
        cfg.modelOrAlias?.choice?.value ??
        Number(String(cfg.modelOrAlias?.model).replace('MODEL_PLACEHOLDER_M', '')) + 1000,
    }));

    // Verify stable sort order: built-in Gemini models first, then custom models in JSON order
    const orchFiltered = filterOptionsForRole(clientOptions, 'orchestrator', patchedRoles);
    const execFiltered = filterOptionsForRole(clientOptions, 'executor', patchedRoles);
    expect(orchFiltered.map((o) => o.label)).toEqual([
      'Gemini 4 Neon (Medium)',
      'Gemini 4 Neon (High)',
      'Gemini 4 Hydrogen',
      'deepseek-v4.1-flash',
      'Zero-AI Executor Sonnet',
    ]);
    expect(execFiltered.map((o) => o.label)).toEqual(orchFiltered.map((o) => o.label));

    // Verify dropdown rows: built-in Gemini 4 Neon has family effort selector; custom models without effort levels do NOT
    const groupedModels = patchedStatus.userStatus.cascadeModelConfigData.groupedModels;
    const orchRows = buildDropdownRows(orchFiltered, groupedModels);
    expect(orchRows).toEqual([
      { kind: 'family', displayName: 'Gemini 4 Neon', tiers: [377, 429] },
      { kind: 'model', option: expect.objectContaining({ label: 'Gemini 4 Hydrogen', value: 456 }) },
      { kind: 'model', option: expect.objectContaining({ label: 'deepseek-v4.1-flash', value: m1Val }) },
      { kind: 'model', option: expect.objectContaining({ label: 'Zero-AI Executor Sonnet', value: m2Val }) },
    ]);

    // Verify selection persistence across restart
    const persistedPrefs = {
      orchestratorModel: m1Val,
      orchestratorExecutorModel: m2Val,
    };
    expect(resolveActiveSelection(orchFiltered, persistedPrefs.orchestratorModel, 'orchestrator', patchedRoles)).toEqual(
      {
        displayed: expect.objectContaining({ label: 'deepseek-v4.1-flash', value: m1Val }),
        runtimeValue: m1Val,
      },
    );
    expect(
      resolveActiveSelection(execFiltered, persistedPrefs.orchestratorExecutorModel, 'executor', patchedRoles),
    ).toEqual({
      displayed: expect.objectContaining({ label: 'Zero-AI Executor Sonnet', value: m2Val }),
      runtimeValue: m2Val,
    });

    // Start a local proxy server using the real subagentRouting + runCustomModelRequest pipeline
    const proxyServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const reqJson = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
        const activeModels = enabledIpcModels as unknown as CustomModel[];
        const requested = activeModels.find(
          (m) => (m as any).nativeModelId === reqJson.model || m.name === reqJson.model,
        );
        const geminiBody = { ...(reqJson.request || reqJson) };
        const prepared = subagentRouting.prepareRequest(
          geminiBody,
          (selector) => resolveConfiguredSubagentModel(activeModels, selector)?.name,
          requested?.name,
        );
        const matched = prepared.modelName
          ? resolveConfiguredSubagentModel(activeModels, prepared.modelName)
          : requested;
        if (!matched) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Model not found' } }));
          return;
        }
        void runCustomModelRequest(res, matched, prepared.body, false, activeModels, true);
      });
    });
    servers.push(proxyServer);
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxyServer.address() as { port: number }).port;
    const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

    // 1. Orchestrator turn using Custom Model 1's assigned placeholder
    const orchRes = await fetch(`${proxyOrigin}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: enabledIpcModels[0].nativeModelId,
        request: {
          labels: { cascade_id: 'orchestrator-conv-1' },
          contents: [{ role: 'user', parts: [{ text: 'Plan the feature and delegate to executor' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'invoke_subagent',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      Subagents: {
                        type: 'ARRAY',
                        items: {
                          type: 'OBJECT',
                          properties: {
                            Model: { type: 'STRING', enum: ['inherit', 'flash_lite', 'flash', 'pro'] },
                            Prompt: { type: 'STRING' },
                            TypeName: { type: 'STRING' },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
    });
    expect(orchRes.status).toBe(200);
    const orchJson = (await orchRes.json()) as Record<string, any>;
    const emittedCall = orchJson.response.candidates[0].content.parts[0].functionCall;
    expect(emittedCall.name).toBe('invoke_subagent');
    const childPromptWithMarker = emittedCall.args.Subagents[0].Prompt as string;

    // 2. Language Server dispatches the Executor subagent using Executor's configured custom model (Custom Model 2)
    const execRes = await fetch(`${proxyOrigin}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: enabledIpcModels[1].nativeModelId,
        request: {
          labels: { cascade_id: 'executor-conv-1' },
          contents: [{ role: 'user', parts: [{ text: childPromptWithMarker }] }],
        },
      }),
    });
    expect(execRes.status).toBe(200);
    const execJson = (await execRes.json()) as Record<string, any>;
    expect(execJson.response.candidates[0].content.parts[0].text).toBe('EXECUTOR COMPLETED TASK ON ENDPOINT 2');

    // Verify endpoint isolation: Orchestrator hit ONLY Endpoint 1, Executor hit ONLY Endpoint 2
    expect(orchRequests).toHaveLength(1);
    expect(orchRequests[0].url).toBe('/gpt/v1/chat/completions');
    expect(orchRequests[0].body.model).toBe('deepseek-v4.1-flash');
    expect(execRequests).toHaveLength(1);
    expect(execRequests[0].url).toBe('/v1/messages');
    expect(execRequests[0].body.model).toBe('claude-sonnet-4-6');

    // 3. Remove/disable the selected Orchestrator model (Custom Model 1) and verify graceful fallback to default Gemini
    await actions['storage:delete-custom-model']('models/deepseek-v4.1-flash');
    const afterRemoveModels = await actions['storage:get-custom-models']();
    const afterRemoveFixture = createFixture(
      new Response(
        JSON.stringify({
          experimentConfig: {
            experiments: [{ keyString: 'orchestrator-model-roles', string: JSON.stringify(baseRoles) }],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
      afterRemoveModels,
    );
    const afterRemoveMendel = await (await afterRemoveFixture.window.fetch(mendelUrl)).json();
    const afterRemoveRoles: MendelRoles = JSON.parse(afterRemoveMendel.experimentConfig.experiments[0].string);
    expect(afterRemoveRoles.orchestrators).toEqual([
      'gemini-4-neon',
      'gemini-4-hydrogen',
      'custom-claude-sonnet-4-6',
    ]);

    const afterRemoveFiltered = filterOptionsForRole(
      clientOptions.filter((o) => o.value !== m1Val),
      'orchestrator',
      afterRemoveRoles,
    );
    const fallbackResolution = resolveActiveSelection(
      afterRemoveFiltered,
      persistedPrefs.orchestratorModel, // still m1Val from before deletion
      'orchestrator',
      afterRemoveRoles,
    );
    // Falls back safely to the first default Gemini model without crashing
    expect(fallbackResolution.displayed?.label).toBe('Gemini 4 Neon (Medium)');
    expect(fallbackResolution.runtimeValue).toBe(0);
  });
});
