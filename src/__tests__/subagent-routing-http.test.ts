import * as loopbackSecurity from '../proxy/loopbackSecurity';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { CustomModel, ProxyStartOptions } from '../proxy';
import { listenProxy } from '../proxy/listen';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import * as modelUtils from '../proxy/modelUtils';
import * as customRequest from '../proxy/customRequest';
import * as shared from '../proxy/shared';
import * as subagentRouting from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { validateCustomModel } from '../schemaValidator';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

type Provider = 'google' | 'openai' | 'anthropic';
type Invocation = { Model?: string; Prompt: string; TypeName?: string };
type ToolCall = { id?: string; name: string; args: { Subagents: Invocation[] } };
type Candidate = { content?: { parts?: { text?: string; functionCall?: ToolCall }[] } };
type Payload = { response?: Payload; candidates?: Candidate[] };
type UpstreamRequest = { provider: Provider; model: string; payload: Record<string, unknown>; wire: string };
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];
const directories: string[] = [];
const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

afterEach(async () => {
  customRequest.stopCustomRequests();
  for (const server of servers) server.closeAllConnections();
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  subagentRouting.subagentRouting.clear();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-subagent-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
afterAll(shared.stopCleanupInterval);

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenProxy(server, 0)}`;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Only the transparent Google transport destination is substituted. Generation uses
// the actual proxy router, bridge, translators and runtime through localhost sockets.
async function fixture(models: CustomModel[], fallback: string) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-subagent-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'custom_models.json'), JSON.stringify({ models }));
  const dependencies: Record<string, unknown> = {
    http: {
      ...http,
      createServer: (handler: http.RequestListener) => {
        const server = http.createServer(handler);
        servers.push(server);
        return server;
      },
    },
    https: {
      request: (target: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
        http.request(new URL(target.pathname + target.search, fallback), options, callback),
    },
    fs,
    path,
    zlib,
    electron: { app: { getAppPath: () => directory } },
    'electron-log': { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    './proxy/shared': shared,
    './proxy/modelUtils': modelUtils,
    './proxy/modelCatalog': modelCatalog,
    './modelIdentity': modelIdentity,
    './proxy/cloudCodeRouting': { CloudCodeRouting },
    './proxy/subagentRouting': subagentRouting,
    './proxy/subagentModels': subagentModels,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/customRequest': customRequest,
    './modelStore': { readModelConfig: () => models.map((model) => ({ ...model })) },
    './schemaValidator': { validateCustomModel },
    './cryptoStore': { decryptModels: (values: CustomModel[]) => values },
    './proxy/googlePoolFailover': { attemptGooglePoolFailover: vi.fn() },
    './proxy/loopbackSecurity': loopbackSecurity,
    './proxy/listen': {
      getRequiredProxyPort: () => undefined,
      listenProxy: (server: http.Server) => listenProxy(server, 0),
    },
  };
  const module = {
    exports: {} as { startProxy(options: ProxyStartOptions): Promise<number>; stopProxy(): Promise<void> },
  };
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
  return `http://127.0.0.1:${await module.exports.startProxy({ dataDirectory: directory })}`;
}

function model(origin: string, provider: Provider, name: string): CustomModel {
  return {
    name: `models/${name}`,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: `${origin}/${provider}/v1${provider === 'google' ? 'beta' : provider === 'openai' ? '/chat/completions' : '/messages'}`,
    externalModelName: name,
    maxRetries: 0,
  };
}

const schema = {
  functionDeclarations: [
    {
      name: 'invoke_subagent',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          Subagents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Model: { type: 'string', enum: ['inherit', 'flash', 'pro'] },
                Prompt: { type: 'string' },
                TypeName: { type: 'string' },
              },
              required: ['Model', 'Prompt'],
            },
          },
        },
        required: ['Subagents'],
      },
    },
  ],
};

const sse = (res: http.ServerResponse, value: unknown) =>
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);

function reply(res: http.ServerResponse, provider: Provider, stream: boolean, invocations?: Invocation[]) {
  const args = { Subagents: invocations };
  const tool = { name: 'invoke_subagent', args };
  if (!stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        provider === 'google'
          ? {
              candidates: [
                {
                  content: { role: 'model', parts: invocations ? [{ functionCall: tool }] : [{ text: 'CHILD OK' }] },
                  finishReason: 'STOP',
                },
              ],
            }
          : provider === 'openai'
            ? {
                choices: [
                  {
                    message: invocations
                      ? {
                          tool_calls: [
                            {
                              id: 'shared-id',
                              type: 'function',
                              function: { name: tool.name, arguments: JSON.stringify(args) },
                            },
                          ],
                        }
                      : { content: 'CHILD OK' },
                    finish_reason: invocations ? 'tool_calls' : 'stop',
                  },
                ],
              }
            : {
                id: 'shared-message',
                type: 'message',
                content: invocations
                  ? [{ type: 'tool_use', id: 'shared-id', name: tool.name, input: args }]
                  : [{ type: 'text', text: 'CHILD OK' }],
                stop_reason: invocations ? 'tool_use' : 'end_turn',
              },
      ),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  if (provider === 'google') {
    sse(res, {
      candidates: [
        {
          content: { role: 'model', parts: invocations ? [{ functionCall: tool }] : [{ text: 'CHILD OK' }] },
          finishReason: 'STOP',
        },
      ],
    });
  } else if (provider === 'openai') {
    if (invocations) {
      const json = JSON.stringify(args);
      const middle = Math.floor(json.length / 2);
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'shared-id',
                  type: 'function',
                  function: { name: tool.name, arguments: json.slice(0, middle) },
                },
              ],
            },
          },
        ],
      });
      sse(res, {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] },
            finish_reason: 'tool_calls',
          },
        ],
      });
    } else {
      sse(res, { choices: [{ delta: { content: 'CHILD OK' }, finish_reason: 'stop' }] });
    }
    sse(res, '[DONE]');
  } else {
    sse(res, { type: 'message_start', message: { id: 'shared-message' } });
    if (invocations) {
      const json = JSON.stringify(args);
      const middle = Math.floor(json.length / 2);
      sse(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'shared-id', name: tool.name, input: {} },
      });
      for (const fragment of [json.slice(0, middle), json.slice(middle)])
        sse(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: fragment },
        });
    } else {
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CHILD OK' } });
    }
    sse(res, { type: 'content_block_stop', index: 0 });
    sse(res, { type: 'message_delta', delta: { stop_reason: invocations ? 'tool_use' : 'end_turn' } });
    sse(res, { type: 'message_stop' });
  }
  res.end();
}

async function providerFixture(choose: (request: UpstreamRequest) => Invocation[] | undefined) {
  const requests: UpstreamRequest[] = [];
  const url = await serve(async (req, res) => {
    const payload = await readBody(req);
    const provider = req.url!.split('/')[1] as Provider;
    const externalModel = String(payload.model || decodeURIComponent(req.url!.match(/\/models\/([^:]+):/)?.[1] || ''));
    const request = { provider, model: externalModel, payload, wire: JSON.stringify(payload) };
    requests.push(request);
    reply(res, provider, payload.stream === true || req.url!.includes('streamGenerateContent'), choose(request));
  });
  return { url, requests };
}

async function request(
  url: string,
  selected: string,
  text: string,
  stream: boolean,
  identity: string,
  contents?: unknown[],
) {
  return fetch(`${url}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: selected,
      request: {
        labels: { cascade_id: identity },
        contents: contents || [{ role: 'user', parts: [{ text }] }],
        tools: [schema],
      },
    }),
  });
}

async function toolCalls(response: Response, stream: boolean) {
  expect(response.status).toBe(200);
  const payloads: Payload[] = stream ? ssePayloads(await response.text()) : [await response.json()];
  return payloads
    .flatMap((payload) => (payload.response || payload).candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []));
}

function ssePayloads(wire: string): Payload[] {
  return wire
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data));
}

type NativeTransport = 'cloud-code' | 'standard';
type NativeEncoding = 'identity' | 'gzip' | 'deflate' | 'br';

function nativePayload(transport: NativeTransport, invocations?: Invocation[]) {
  const response = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: invocations
            ? [{ functionCall: { name: 'invoke_subagent', args: { Subagents: invocations } } }]
            : [{ text: 'NATIVE OK: İstanbul 🚀' }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9 },
  };
  return transport === 'cloud-code' ? { response, traceId: 'native-trace', metadata: { unchanged: true } } : response;
}

function compressed(wire: string, encoding: NativeEncoding): Buffer {
  const bytes = Buffer.from(wire);
  if (encoding === 'gzip') return zlib.gzipSync(bytes);
  if (encoding === 'deflate') return zlib.deflateSync(bytes);
  if (encoding === 'br') return zlib.brotliCompressSync(bytes);
  return bytes;
}

async function nativeRequest(
  proxy: string,
  transport: NativeTransport,
  stream: boolean,
  identity: string,
  text = 'Start native parent',
) {
  const endpoint = transport === 'cloud-code' ? '/v1internal' : '/v1beta/models/gemini-native-pro';
  const body = { labels: { cascade_id: identity }, contents: [{ role: 'user', parts: [{ text }] }], tools: [schema] };
  return fetch(`${proxy}${endpoint}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transport === 'cloud-code' ? { model: 'gemini-native-pro', request: body } : body),
  });
}

async function nativeFixture(options: {
  transport: NativeTransport;
  stream: boolean;
  encoding?: NativeEncoding;
  invocations?: Invocation[];
  wire?: string;
  status?: number;
  contentType?: string;
  fragmented?: boolean;
}) {
  const requests: Record<string, unknown>[] = [];
  const payload = nativePayload(options.transport, options.invocations);
  const wire =
    options.wire ?? (options.stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload));
  const bytes = compressed(wire, options.encoding || 'identity');
  const url = await serve(async (req, res) => {
    requests.push(await readBody(req));
    res.statusCode = options.status || 200;
    res.setHeader('Content-Type', options.contentType || (options.stream ? 'text/event-stream' : 'application/json'));
    if (options.encoding && options.encoding !== 'identity') res.setHeader('Content-Encoding', options.encoding);
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('X-Upstream-Trace', 'native-fixture');
    if (!options.fragmented) {
      res.end(bytes);
      return;
    }
    // Write individual bytes across event-loop turns, including multibyte UTF-8,
    // CRLF delimiters, and JSON tokens. No chunk can be assumed to be a line.
    for (let index = 0; index < bytes.length && !res.destroyed; index++) {
      res.write(bytes.subarray(index, index + 1));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  return { url, requests, payload, wire };
}

const crossProviderCases = (['google', 'openai', 'anthropic'] as const).flatMap((parentProvider) =>
  (['google', 'openai', 'anthropic'] as const)
    .filter((childProvider) => childProvider !== parentProvider)
    .flatMap((childProvider) => [false, true].map((stream) => ({ parentProvider, childProvider, stream }))),
);

describe('subagent bridge through native-shaped HTTP requests', () => {
  it.each(crossProviderCases)(
    'routes the first child $parentProvider → $childProvider, stream=$stream',
    async ({ parentProvider, childProvider, stream }) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent'
          ? [{ Model: 'models/child', Prompt: 'Execute CHILD TASK', TypeName: 'research' }]
          : undefined,
      );
      const parent = model(upstream.url, parentProvider, 'parent');
      const child = model(upstream.url, childProvider, 'child');
      const proxy = await fixture([parent, child], upstream.url);
      const [call] = await toolCalls(
        await request(proxy, parent.name, 'Start parent', stream, 'parent-cascade'),
        stream,
      );
      expect(call.name).toBe('invoke_subagent');
      const [invocation] = call.args.Subagents;
      expect(invocation).toMatchObject({ Model: 'inherit', TypeName: 'research' });
      expect(invocation.Prompt).toContain('Execute CHILD TASK');
      expect(invocation.Prompt).not.toBe('Execute CHILD TASK');
      expect(invocation.Prompt).not.toContain(child.name);

      // No functionResponse has been sent back to the parent when the child starts.
      const response = await request(proxy, parent.name, invocation.Prompt, stream, 'child-cascade');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
      expect(upstream.requests.map(({ provider, model: selected }) => [provider, selected])).toEqual([
        [parentProvider, 'parent'],
        [childProvider, 'child'],
      ]);
      expect(upstream.requests[1].wire).toContain('Execute CHILD TASK');
      expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
      // The provider sees a selectable custom-model field, not the IDE's tier-only enum.
      expect(upstream.requests[0].wire).toContain('exact saved name');
      expect(upstream.requests[0].wire).not.toContain('"enum":["inherit","flash","pro"]');
    },
  );

  it('keeps concurrent ID-less Google parents and two siblings independent', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? input.wire.includes('PARENT A')
          ? [
              { Model: 'models/child-a', Prompt: 'TASK A' },
              { Model: 'models/child-b', Prompt: 'TASK A SIBLING' },
            ]
          : [{ Model: 'models/child-b', Prompt: 'TASK B' }]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const children = [model(upstream.url, 'openai', 'child-a'), model(upstream.url, 'anthropic', 'child-b')];
    const proxy = await fixture([parent, ...children], upstream.url);
    const [[callA], [callB]] = await Promise.all([
      request(proxy, parent.name, 'PARENT A', true, 'parent-a').then((response) => toolCalls(response, true)),
      request(proxy, parent.name, 'PARENT B', true, 'parent-b').then((response) => toolCalls(response, true)),
    ]);
    const all = [...callA.args.Subagents, ...callB.args.Subagents];
    expect(new Set(all.map((invocation) => invocation.Prompt)).size).toBe(3);
    const responses = await Promise.all([
      request(proxy, parent.name, callB.args.Subagents[0].Prompt, true, 'child-b'),
      request(proxy, parent.name, callA.args.Subagents[1].Prompt, false, 'child-a-sibling'),
      request(proxy, parent.name, callA.args.Subagents[0].Prompt, true, 'child-a'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
    }
    const childRequests = upstream.requests.filter((input) => input.model !== 'parent');
    expect(childRequests).toHaveLength(3);
    for (const childRequest of childRequests) {
      expect(childRequest.model).toBe(
        childRequest.wire.includes('TASK A') && !childRequest.wire.includes('SIBLING') ? 'child-a' : 'child-b',
      );
      expect(childRequest.wire).not.toContain('antigravity-subagent-route:');
    }
  });

  it('does not route a parent history or a later built-in invocation to a stale custom child', async () => {
    const builtinRequests: Record<string, unknown>[] = [];
    const builtin = await serve(async (req, res) => {
      builtinRequests.push(await readBody(req));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'BUILTIN OK' }] } }] } }));
    });
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? [{ Model: input.wire.includes('USE BUILTIN') ? 'pro' : 'models/child', Prompt: 'Fresh task' }]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const child = model(upstream.url, 'openai', 'child');
    const proxy = await fixture([parent, child], builtin);
    const [first] = await toolCalls(await request(proxy, parent.name, 'USE CUSTOM', false, 'parent'), false);
    const history = [
      { role: 'model', parts: [{ functionCall: first }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: first.name, response: { output: '{"conversationId":"existing-child"}' } } },
        ],
      },
      { role: 'user', parts: [{ text: 'USE BUILTIN' }] },
    ];
    const [next] = await toolCalls(await request(proxy, parent.name, '', false, 'parent', history), false);
    expect(next.args.Subagents).toEqual([{ Model: 'pro', Prompt: 'Fresh task' }]);
    expect(upstream.requests.map((input) => input.model)).toEqual(['parent', 'parent']);
    expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
    expect(upstream.requests[1].wire).toContain(child.name);
    const builtinResponse = await request(
      proxy,
      'gemini-native-pro',
      next.args.Subagents[0].Prompt,
      false,
      'builtin-child',
    );
    expect(builtinResponse.status).toBe(200);
    expect(await builtinResponse.text()).toContain('BUILTIN OK');
    expect(builtinRequests).toHaveLength(1);
    expect(builtinRequests[0].model).toBe('gemini-native-pro');
    expect(upstream.requests).toHaveLength(2);
  });

  it('rejects an expired or unknown opaque route instead of forwarding it upstream', async () => {
    const upstream = await providerFixture(() => undefined);
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture([parent], upstream.url);
    const response = await request(
      proxy,
      parent.name,
      'Task\n\n[antigravity-subagent-route:11111111-1111-4111-8111-111111111111]',
      false,
      'unknown-child',
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each(['openai', 'anthropic'] as const)(
    'restores ID-less Google parent history when switching to %s',
    async (provider) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent-google' ? [{ Model: 'models/child', Prompt: 'Preserve the child task' }] : undefined,
      );
      const originalParent = model(upstream.url, 'google', 'parent-google');
      const switchedParent = model(upstream.url, provider, 'parent-switched');
      const child = model(upstream.url, 'google', 'child');
      const proxy = await fixture([originalParent, switchedParent, child], upstream.url);
      const [first] = await toolCalls(await request(proxy, originalParent.name, 'Start parent', true, 'parent'), true);
      const childResponse = await request(proxy, originalParent.name, first.args.Subagents[0].Prompt, false, 'child');
      expect(childResponse.status).toBe(200);
      expect(await childResponse.text()).toContain('CHILD OK');
      const history = [
        { role: 'user', parts: [{ text: 'Start parent' }] },
        { role: 'model', parts: [{ functionCall: first }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: first.name, response: { output: '{"conversationId":"child"}' } } }],
        },
        { role: 'user', parts: [{ text: 'Summarize the result' }] },
      ];
      const response = await request(proxy, switchedParent.name, '', true, 'parent', history);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
      expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
        ['google', 'parent-google'],
        ['google', 'child'],
        [provider, 'parent-switched'],
      ]);
      const wire = upstream.requests[2].wire;
      expect(wire).toContain('Preserve the child task');
      expect(wire).not.toContain('antigravity-subagent-route:');
      const messages = upstream.requests[2].payload.messages as {
        role: string;
        tool_calls?: { function: { arguments: string } }[];
        content?: { type: string; input?: unknown }[];
      }[];
      const assistant = messages.find((message) => message.role === 'assistant')!;
      const replay =
        provider === 'openai'
          ? JSON.parse(assistant.tool_calls![0].function.arguments)
          : assistant.content!.find((content) => content.type === 'tool_use')!.input;
      expect(replay).toEqual({ Subagents: [{ Model: child.name, Prompt: 'Preserve the child task' }] });
    },
  );

  it('rejects contradictory known markers without dispatching either route', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? [
            { Model: 'models/child-a', Prompt: 'TASK A' },
            { Model: 'models/child-b', Prompt: 'TASK B' },
          ]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture(
      [parent, model(upstream.url, 'openai', 'child-a'), model(upstream.url, 'anthropic', 'child-b')],
      upstream.url,
    );
    const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
    const contradictory = call.args.Subagents.map((invocation) => invocation.Prompt).join('\n');
    const response = await request(proxy, parent.name, contradictory, false, 'child');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(upstream.requests).toHaveLength(1);
  });

  it.each([true, false])(
    'keeps the actual child model for grandchildren with explicit inherit=%s',
    async (explicit) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent'
          ? [{ Model: 'models/child', Prompt: 'SPAWN NESTED' }]
          : input.wire.includes('SPAWN NESTED')
            ? [{ ...(explicit ? { Model: 'inherit' } : {}), Prompt: 'Final grandchild task' }]
            : undefined,
      );
      const parent = model(upstream.url, 'google', 'parent');
      const child = model(upstream.url, 'anthropic', 'child');
      const proxy = await fixture([parent, child], upstream.url);
      const [parentCall] = await toolCalls(await request(proxy, parent.name, 'Start parent', true, 'parent'), true);
      const [childCall] = await toolCalls(
        await request(proxy, parent.name, parentCall.args.Subagents[0].Prompt, true, 'child'),
        true,
      );
      const grandchildResponse = await request(
        proxy,
        parent.name,
        childCall.args.Subagents[0].Prompt,
        true,
        'grandchild',
      );
      expect(grandchildResponse.status).toBe(200);
      expect(await grandchildResponse.text()).toContain('CHILD OK');
      expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
        ['google', 'parent'],
        ['anthropic', 'child'],
        ['anthropic', 'child'],
      ]);
      expect(upstream.requests[2].wire).not.toContain('antigravity-subagent-route:');
      // Continuations remain on the same child after the transport marker is stripped.
      const continued = await request(proxy, parent.name, 'Continue grandchild', false, 'grandchild');
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain('CHILD OK');
      expect(upstream.requests[3].model).toBe('child');
    },
  );

  it('routes standard Gemini generation before a built-in URL selector reaches Google', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent' ? [{ Model: 'models/child', Prompt: 'STANDARD CHILD TASK' }] : undefined,
    );
    const parent = model(upstream.url, 'openai', 'parent');
    const child = model(upstream.url, 'google', 'child');
    const proxy = await fixture([parent, child], upstream.url);
    const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
    const response = await fetch(`${proxy}/v1beta/models/gemini-native-pro:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'standard-child',
        contents: [{ role: 'user', parts: [{ text: call.args.Subagents[0].Prompt }] }],
      }),
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('CHILD OK');
    expect(wire).not.toContain('"response":');
    expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
      ['openai', 'parent'],
      ['google', 'child'],
    ]);
    expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
  });

  it.each(['cloud-code', 'standard'] as const)(
    'restores parent history when switching to a native model over %s',
    async (transport) => {
      const builtinRequests: Record<string, unknown>[] = [];
      const builtin = await serve(async (req, res) => {
        builtinRequests.push(await readBody(req));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'NATIVE PARENT OK' }] } }] }));
      });
      const upstream = await providerFixture((input) =>
        input.model === 'parent' ? [{ Model: 'models/child', Prompt: 'Preserve the original task' }] : undefined,
      );
      const parent = model(upstream.url, 'google', 'parent');
      const child = model(upstream.url, 'openai', 'child');
      const proxy = await fixture([parent, child], builtin);
      const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
      const history = [
        { role: 'user', parts: [{ text: 'Start parent' }] },
        { role: 'model', parts: [{ functionCall: call }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: call.name, response: { output: '{"conversationId":"child"}' } } }],
        },
        { role: 'user', parts: [{ text: 'Summarize with the native model' }] },
      ];
      const response =
        transport === 'cloud-code'
          ? await fetch(`${proxy}/v1internal:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gemini-native-pro',
                conversationId: 'parent',
                sessionId: 'outer-session',
                request: { contents: history, tools: [schema] },
              }),
            })
          : await fetch(`${proxy}/v1beta/models/gemini-native-pro:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ labels: { cascade_id: 'parent' }, contents: history, tools: [schema] }),
            });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('NATIVE PARENT OK');
      expect(upstream.requests).toHaveLength(1);
      expect(builtinRequests).toHaveLength(1);
      const forwarded = builtinRequests[0];
      expect(JSON.stringify(forwarded)).not.toContain('antigravity-subagent-route:');
      const nativeBody = (transport === 'cloud-code' ? forwarded.request : forwarded) as {
        contents: { parts: { functionCall?: ToolCall }[] }[];
        tools: unknown[];
      };
      expect(nativeBody.contents[1].parts[0].functionCall?.args).toEqual({
        Subagents: [{ Model: child.name, Prompt: 'Preserve the original task' }],
      });
      if (transport === 'cloud-code') {
        expect(forwarded.conversationId).toBe('parent');
        expect(forwarded.sessionId).toBe('outer-session');
        expect(nativeBody).not.toHaveProperty('conversationId');
        expect(nativeBody).not.toHaveProperty('sessionId');
      }
      expect(JSON.stringify(nativeBody.tools)).not.toContain('"enum":["inherit","flash","pro"]');
      expect(JSON.stringify(nativeBody.tools)).toContain('exact saved name');
    },
  );

  it('rejects malformed Cloud Code contents before any upstream request', async () => {
    const upstream = await providerFixture(() => undefined);
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture([parent], upstream.url);
    const response = await fetch(`${proxy}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: parent.name, request: { contents: {} } }),
    });
    expect(response.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });
});

const nativeCases = (['identity', 'gzip', 'deflate', 'br'] as const)
  .flatMap((encoding) =>
    [false, true].map((stream) => ({ transport: 'cloud-code' as NativeTransport, encoding, stream })),
  )
  .concat(
    [false, true].map((stream) => ({
      transport: 'standard' as NativeTransport,
      encoding: 'gzip' as NativeEncoding,
      stream,
    })),
  );

describe('built-in parent to custom subagent through native Google HTTP forwarding', () => {
  it('relaxes both native schema forms while preserving unrelated enum constraints', async () => {
    const builtin = await nativeFixture({ transport: 'cloud-code', stream: false });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const parameters = structuredClone(schema.functionDeclarations[0].parametersJsonSchema);
    const tools = [
      {
        functionDeclarations: [
          { name: 'invoke_subagent', parameters, parametersJsonSchema: parameters },
          {
            name: 'other_tool',
            parameters: { type: 'object', properties: { Model: { type: 'string', enum: ['allowed'] } } },
          },
        ],
      },
    ];
    const response = await fetch(`${proxy}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-native-pro',
        request: {
          conversationId: 'schema-parent',
          contents: [{ role: 'user', parts: [{ text: 'Schema test' }] }],
          tools,
        },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    const forwarded = builtin.requests[0].request as { tools: typeof tools };
    const invocation = forwarded.tools[0].functionDeclarations[0];
    for (const field of ['parameters', 'parametersJsonSchema'] as const) {
      const modified = invocation[field] as typeof parameters;
      expect(modified.properties.Subagents.items.properties.Model).not.toHaveProperty('enum');
      expect(modified.properties.Subagents.items.properties.Model).toHaveProperty(
        'description',
        expect.stringContaining('exact saved name'),
      );
      expect(modified.properties.Subagents.items.required).toEqual(['Model', 'Prompt']);
    }
    expect(forwarded.tools[0].functionDeclarations[1]).toEqual(tools[0].functionDeclarations[1]);
    expect(parameters.properties.Subagents.items.properties.Model.enum).toEqual(['inherit', 'flash', 'pro']);
  });

  it.each(nativeCases)(
    'routes first child over $transport, stream=$stream, encoding=$encoding',
    async ({ transport, stream, encoding }) => {
      const builtin = await nativeFixture({
        transport,
        stream,
        encoding,
        invocations: [{ Model: 'models/child', Prompt: 'Native parent child task: İstanbul 🚀', TypeName: 'research' }],
      });
      const upstream = await providerFixture(() => undefined);
      const child = model(upstream.url, stream ? 'anthropic' : 'openai', 'child');
      const proxy = await fixture([child], builtin.url);
      const response = await nativeRequest(proxy, transport, stream, 'native-parent');
      expect(response.status).toBe(200);
      expect(response.headers.get('x-upstream-trace')).toBe('native-fixture');
      const wire = await response.text();
      const payloads = stream ? ssePayloads(wire) : [JSON.parse(wire) as Payload];
      expect(JSON.stringify(payloads)).toContain('"promptTokenCount":12');
      if (transport === 'cloud-code') {
        expect(JSON.stringify(payloads)).toContain('"traceId":"native-trace"');
        expect(JSON.stringify(payloads)).toContain('"metadata":{"unchanged":true}');
      }
      const [call] = payloads
        .flatMap((payload) => (payload.response || payload).candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .flatMap((part) => (part.functionCall ? [part.functionCall] : []));
      expect(call?.args.Subagents[0]).toMatchObject({ Model: 'inherit', TypeName: 'research' });
      expect(call.args.Subagents[0].Prompt).toContain('Native parent child task: İstanbul 🚀');
      expect(call.args.Subagents[0].Prompt).toContain('[antigravity-subagent-route:');
      const forwarded = JSON.stringify(builtin.requests[0]);
      expect(forwarded).toContain('exact saved name');
      expect(forwarded).not.toContain('"enum":["inherit","flash","pro"]');

      // Child starts before the native parent receives any invoke_subagent result.
      const result = await nativeRequest(proxy, transport, stream, 'native-child', call.args.Subagents[0].Prompt);
      expect(result.status).toBe(200);
      expect(await result.text()).toContain('CHILD OK');
      expect(builtin.requests).toHaveLength(1);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].model).toBe('child');
      expect(upstream.requests[0].wire).toContain('Native parent child task: İstanbul 🚀');
      expect(upstream.requests[0].wire).not.toContain('antigravity-subagent-route:');
    },
  );

  it('rewrites wrapped SSE split inside UTF-8, CRLF delimiters and multiline data fields', async () => {
    const payload = nativePayload('cloud-code', [{ Model: 'models/child', Prompt: 'Görev 🚀 中文' }]);
    const json = JSON.stringify(payload, null, 2);
    const wire = `: keep alive\r\nevent: message\r\nid: event-7\r\n${json
      .split('\n')
      .map((line) => `data: ${line}\r\n`)
      .join('')}\r\ndata: [DONE]\r\n\r\n`;
    const builtin = await nativeFixture({ transport: 'cloud-code', stream: true, wire, fragmented: true });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const response = await nativeRequest(proxy, 'cloud-code', true, 'fragment-parent');
    expect(response.status).toBe(200);
    const forwarded = await response.text();
    expect(forwarded).toContain('event: message');
    expect(forwarded).toContain('id: event-7');
    expect(forwarded).toContain('[DONE]');
    expect(forwarded).not.toContain('�');
    const call = ssePayloads(forwarded)[0].response!.candidates![0].content!.parts![0].functionCall!;
    expect(call.args.Subagents[0].Model).toBe('inherit');
    const childResponse = await nativeRequest(
      proxy,
      'cloud-code',
      false,
      'fragment-child',
      call.args.Subagents[0].Prompt,
    );
    expect(childResponse.status).toBe(200);
    await childResponse.text();
    expect(upstream.requests[0].wire).toContain('Görev 🚀 中文');
  });

  it.each([false, true])('preserves explicit native tiers and inherit, stream=%s', async (stream) => {
    const invocations: Invocation[] = ['flash_lite', 'flash', 'pro', 'inherit'].map((Model) => ({
      Model,
      Prompt: `${Model} task`,
    }));
    invocations.push({ Prompt: 'omitted model task' });
    const builtin = await nativeFixture({ transport: 'cloud-code', stream, invocations });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const [call] = await toolCalls(await nativeRequest(proxy, 'cloud-code', stream, 'tier-parent'), stream);
    expect(call.args.Subagents).toEqual(invocations);
    expect(JSON.stringify(call)).not.toContain('antigravity-subagent-route:');
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([false, true].flatMap((stream) => ['unknown', 'disabled'].map((kind) => ({ stream, kind }))))(
    'fails explicitly for $kind custom selection before output, stream=$stream',
    async ({ stream, kind }) => {
      const builtin = await nativeFixture({
        transport: 'cloud-code',
        stream,
        invocations: [{ Model: `models/${kind}`, Prompt: 'Do not execute an invalid selection' }],
      });
      const upstream = await providerFixture(() => undefined);
      const disabled = { ...model(upstream.url, 'openai', 'disabled'), enabled: false };
      const proxy = await fixture([model(upstream.url, 'openai', 'child'), disabled], builtin.url);
      const response = await nativeRequest(proxy, 'cloud-code', stream, 'invalid-parent');
      expect(response.status).toBe(400);
      const wire = await response.text();
      expect(wire).toContain('error');
      expect(wire).not.toContain('"functionCall"');
      expect(wire).not.toContain('antigravity-subagent-route:');
      expect(upstream.requests).toHaveLength(0);
    },
  );

  it('reports a bad model in a later SSE event without forwarding its executable tool call', async () => {
    const first = nativePayload('cloud-code');
    const invalid = nativePayload('cloud-code', [{ Model: 'models/missing', Prompt: 'Must not run' }]);
    const wire = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(invalid)}\n\ndata: [DONE]\n\n`;
    const builtin = await nativeFixture({ transport: 'cloud-code', stream: true, wire });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const response = await nativeRequest(proxy, 'cloud-code', true, 'late-error-parent');
    expect(response.status).toBe(200);
    const forwarded = await response.text();
    expect(forwarded).toContain('NATIVE OK');
    expect(forwarded).toContain('error');
    expect(forwarded).not.toContain('"functionCall"');
    expect(upstream.requests).toHaveLength(0);
  });

  it('rewrites a compressed JSON array returned from the streaming endpoint', async () => {
    const payload = nativePayload('cloud-code', [{ Model: 'models/child', Prompt: 'Array child task' }]);
    const builtin = await nativeFixture({
      transport: 'cloud-code',
      stream: true,
      encoding: 'gzip',
      contentType: 'application/json',
      wire: JSON.stringify([nativePayload('cloud-code'), payload]),
    });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'google', 'child')], builtin.url);
    const response = await nativeRequest(proxy, 'cloud-code', true, 'array-parent');
    expect(response.status).toBe(200);
    const data = (await response.json()) as Payload[];
    expect(data).toHaveLength(2);
    const invocation = data[1].response!.candidates![0].content!.parts![0].functionCall!.args.Subagents[0];
    expect(invocation.Model).toBe('inherit');
    const childResponse = await nativeRequest(proxy, 'cloud-code', false, 'array-child', invocation.Prompt);
    expect(childResponse.status).toBe(200);
    await childResponse.text();
    expect(upstream.requests[0].model).toBe('child');
  });

  it.each([false, true])('keeps compressed ordinary native responses readable, stream=%s', async (stream) => {
    const builtin = await nativeFixture({ transport: 'cloud-code', stream, encoding: 'gzip' });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const response = await nativeRequest(proxy, 'cloud-code', stream, 'ordinary-parent');
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('NATIVE OK: İstanbul 🚀');
    expect(wire).not.toContain('�');
    expect(wire).not.toContain('antigravity-subagent-route:');
    expect(upstream.requests).toHaveLength(0);
  });

  it('preserves upstream HTTP error status and compressed non-JSON error response', async () => {
    const builtin = await nativeFixture({
      transport: 'cloud-code',
      stream: true,
      encoding: 'gzip',
      status: 429,
      contentType: 'text/plain',
      wire: 'Native quota exceeded: İstanbul 🚀',
    });
    const upstream = await providerFixture(() => undefined);
    const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
    const response = await nativeRequest(proxy, 'cloud-code', true, 'quota-parent');
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBe(String(compressed(builtin.wire, 'gzip').length));
    expect(await response.text()).toBe('Native quota exceeded: İstanbul 🚀');
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([false, true])(
    'preserves unrecognized malformed native data without introducing a routing failure, stream=%s',
    async (stream) => {
      const builtin = await nativeFixture({
        transport: 'cloud-code',
        stream,
        wire: stream ? 'data: {"response": BROKEN}\n\n' : '{"response": BROKEN}',
      });
      const upstream = await providerFixture(() => undefined);
      const proxy = await fixture([model(upstream.url, 'openai', 'child')], builtin.url);
      const response = await nativeRequest(proxy, 'cloud-code', stream, 'malformed-parent');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(builtin.wire);
      expect(upstream.requests).toHaveLength(0);
    },
  );
});
