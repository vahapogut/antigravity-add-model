import * as googlePoolFailover from '../proxy/googlePoolFailover';
import * as loopbackSecurity from '../proxy/loopbackSecurity';
import * as subagentRoutingModule from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import * as nativeSubagentResponse from '../proxy/nativeSubagentResponse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { listenProxy } from '../proxy/listen';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import * as customRequest from '../proxy/customRequest';
import type { ProxyStartOptions } from '../proxy';
import { clearOfficialQuota, getOfficialQuota, recordOfficialQuota } from '../proxy/shared';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];
const directories: string[] = [];

afterEach(async () => {
  clearOfficialQuota();
  // Close sockets even when a malformed forwarded response makes the client reject.
  for (const server of servers) server.closeAllConnections();
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-forwarding-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenProxy(server, 0)}`;
}

async function fixture(
  upstream: string,
  ideCloudCodeRouting = false,
  lookup?: ConstructorParameters<typeof CloudCodeRouting>[1],
  shutdownGraceMs?: number,
  models: Record<string, unknown>[] = [],
) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-forwarding-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'custom_models.json'), '{"models":[]}');
  // Only the transport destination changes: both sides use real HTTP parsers and sockets.
  const forwarded: { target: string; headers: http.OutgoingHttpHeaders }[] = [];
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
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
      request: (target: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
        forwarded.push({ target: target.href, headers: { ...options.headers } });
        return http.request(new URL(target.pathname + target.search, upstream), options, callback);
      },
    },
    fs,
    path,
    zlib,
    electron: { app: { getAppPath: () => path.resolve('scratch/forwarding-fixture') } },
    'electron-log': log,
    './proxy/shared': { startCleanupInterval: vi.fn(), stopCleanupInterval: vi.fn(), recordOfficialQuota },
    './proxy/modelUtils': {},
    './proxy/modelCatalog': modelCatalog,
    './modelIdentity': modelIdentity,
    './proxy/subagentRouting': subagentRoutingModule,
    './proxy/subagentModels': subagentModels,
    './proxy/googlePoolFailover': googlePoolFailover,
    './proxy/nativeSubagentResponse': nativeSubagentResponse,
    './proxy/cloudCodeRouting': {
      CloudCodeRouting: class extends CloudCodeRouting {
        constructor() {
          super(Date.now, lookup);
        }
      },
    },
    './proxy/customRequest': customRequest,
    './modelStore': { readModelConfig: () => models },
    './schemaValidator': { validateCustomModel: () => ({ valid: true }) },
    './cryptoStore': {
      decryptModels: (models: unknown) => JSON.parse(JSON.stringify(models)),
      decryptString: (value: string) => value,
    },
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
    AbortController,
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
  });
  proxies.push(module.exports);
  return {
    url: `http://127.0.0.1:${await module.exports.startProxy({ dataDirectory: directory, ideCloudCodeRouting, shutdownGraceMs })}`,
    forwarded,
    log,
    stop: module.exports.stopProxy,
  };
}

function post(url: string, body: string, chunked: boolean) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer forwarding-fixture-token',
          'content-type': 'application/json',
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) }),
          'accept-encoding': 'gzip',
          connection: 'close, x-fixture-request-hop',
          'x-fixture-request-hop': 'must-not-forward',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.setTimeout(3000, () => request.destroy(new Error('Forwarding fixture timed out')));
    request.on('error', reject);
    if (chunked) {
      request.write(body.slice(0, 3));
      request.end(body.slice(3));
    } else request.end(body);
  });
}

describe('OpenAI tool reasoning through the desktop HTTP proxy', () => {
  it.each([
    { stream: false, omitThought: false },
    { stream: true, omitThought: false },
    { stream: false, omitThought: true },
    { stream: true, omitThought: true },
  ])(
    'replays reasoning with a tool result without exposing it as content (stream=$stream, IDE omits thought=$omitThought)',
    async ({ stream, omitThought }) => {
      const reasoning = 'Inspect the fixture before answering. Keep this analysis with the tool call.';
      const visible = 'I will read the fixture.';
      const toolCall = {
        id: 'reasoning-replay-call',
        type: 'function',
        function: { name: 'fixture_read', arguments: JSON.stringify({ path: '/fixture.txt' }) },
      };
      const received: {
        path: string;
        body: { model: string; stream: boolean; messages: Record<string, unknown>[] };
      }[] = [];
      const upstream = await serve((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({ path: req.url || '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          const firstTurn = received.length === 1;
          if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            const deltas = firstTurn
              ? [
                  { delta: { reasoning_content: reasoning } },
                  { delta: { content: visible } },
                  { delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' },
                ]
              : [{ delta: { content: 'Fixture read successfully.' }, finish_reason: 'stop' }];
            for (const choice of deltas) res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
            res.end('data: [DONE]\n\n');
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: firstTurn
                      ? { role: 'assistant', content: visible, reasoning_content: reasoning, tool_calls: [toolCall] }
                      : { role: 'assistant', content: 'Fixture read successfully.' },
                    finish_reason: firstTurn ? 'tool_calls' : 'stop',
                  },
                ],
              }),
            );
          }
        });
      });
      const modelName = 'models/reasoning-replay-fixture';
      const proxy = await fixture(upstream, false, undefined, undefined, [
        {
          name: modelName,
          displayName: 'Reasoning replay fixture',
          description: '',
          provider: 'openai',
          apiKey: 'local-fixture-key',
          encrypted: true,
          apiUrl: upstream,
          externalModelName: 'reasoning-fixture',
          maxRetries: 0,
        },
      ]);
      const endpoint = `${proxy.url}/v1beta/${modelName}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
      const user = { role: 'user', parts: [{ text: 'Read the fixture, then answer.' }] };
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'fixture_read',
              parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
            },
          ],
        },
      ];
      const labels = { cascade_id: 'reasoning-replay-fixture-cascade' };
      const first = await post(endpoint, JSON.stringify({ contents: [user], tools, labels }), false);
      expect(first.status).toBe(200);
      type Part = { text?: string; thought?: boolean; functionCall?: { id: string; name: string; args: unknown } };
      type Reply = { candidates: { content: { parts: Part[] } }[] };
      const replies: Reply[] = stream
        ? first.body
            .toString('utf8')
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)))
        : [JSON.parse(first.body.toString('utf8'))];
      const parts = replies.flatMap((reply) => reply.candidates.flatMap((candidate) => candidate.content.parts));
      expect(
        parts
          .filter((part) => part.thought)
          .map((part) => part.text)
          .join(''),
      ).toBe(reasoning);
      expect(
        parts
          .filter((part) => !part.thought && part.text)
          .map((part) => part.text)
          .join(''),
      ).toBe(visible);
      expect(parts.filter((part) => part.functionCall)).toEqual([
        {
          functionCall: {
            id: toolCall.id,
            name: toolCall.function.name,
            args: { path: '/fixture.txt' },
          },
        },
      ]);
      const toolResult = { content: 'fixture file content' };
      const replay = await post(
        endpoint,
        JSON.stringify({
          contents: [
            user,
            { role: 'model', parts: omitThought ? parts.filter((part) => !part.thought) : parts },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    response: toolResult,
                  },
                },
              ],
            },
          ],
          tools,
          labels,
        }),
        true,
      );
      expect(replay.status).toBe(200);
      expect(replay.body.toString('utf8')).toContain('Fixture read successfully.');
      expect(received).toHaveLength(2);
      expect(received.map((request) => request.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
      expect(received[1].body).toMatchObject({ model: 'reasoning-fixture', stream });
      expect(received[1].body.messages).toEqual([
        { role: 'user', content: 'Read the fixture, then answer.' },
        { role: 'assistant', content: visible, reasoning_content: reasoning, tool_calls: [toolCall] },
        { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id },
      ]);
    },
  );
});

describe('IDE history that omits tool reasoning', () => {
  type Part = { text?: string; thought?: boolean; functionCall?: { id: string; name: string; args: unknown } };
  type Content = { role: string; parts: Record<string, unknown>[] };
  type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
  type Turn = { reasoning: string; calls: Call[] };
  const identity = { labels: { cascade_id: 'omitted-reasoning-cascade' } };
  const call = (id: string, file: string): Call => ({
    id,
    type: 'function',
    function: { name: 'fixture_read', arguments: JSON.stringify({ path: file }) },
  });

  async function replayFixture(stream: boolean, turns: Turn[], outcome: 'success' | 'truncated' | 'error' = 'success') {
    const received: { model: string; messages: Record<string, unknown>[] }[] = [];
    const upstream = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const turn = turns[received.length];
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          const choices = turn
            ? [
                { delta: { reasoning_content: turn.reasoning } },
                {
                  delta: { tool_calls: turn.calls.map((tool, index) => ({ index, ...tool })) },
                  ...(outcome === 'truncated' ? {} : { finish_reason: 'tool_calls' }),
                },
              ]
            : [{ delta: { content: 'Finished.' }, finish_reason: 'stop' }];
          for (const choice of choices) res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
          if (turn && outcome === 'error')
            res.end(`data: ${JSON.stringify({ error: { message: 'Fixture failure.' } })}\n\n`);
          else res.end(turn && outcome === 'truncated' ? '' : 'data: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: turn
                    ? { content: '', reasoning_content: turn.reasoning, tool_calls: turn.calls }
                    : { content: 'Finished.' },
                  finish_reason: turn ? 'tool_calls' : 'stop',
                },
              ],
            }),
          );
        }
      });
    });
    const model = {
      name: 'models/omitted-reasoning-fixture',
      displayName: 'Omitted reasoning fixture',
      provider: 'openai',
      apiKey: 'omitted-reasoning-local-key',
      encrypted: true,
      apiUrl: upstream,
      externalModelName: 'omitted-reasoning-model',
      maxRetries: 0,
    };
    const proxy = await fixture(upstream, false, undefined, undefined, [model]);
    return {
      model,
      received,
      async send(contents: Content[], scope: Record<string, unknown>, expectStreamError = false) {
        const endpoint = `${proxy.url}/v1beta/${model.name}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
        const response = await post(endpoint, JSON.stringify({ contents, ...scope }), false);
        expect(response.status).toBe(200);
        const replies: { candidates?: { content: { parts: Part[] } }[]; error?: unknown }[] = stream
          ? response.body
              .toString('utf8')
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => JSON.parse(line.slice(6)))
          : [JSON.parse(response.body.toString('utf8'))];
        expect(replies.some((reply) => reply.error)).toBe(expectStreamError);
        return replies.flatMap((reply) => reply.candidates?.flatMap((candidate) => candidate.content.parts) || []);
      },
    };
  }

  function appendToolTurn(history: Content[], parts: Part[]): Content[] {
    return [
      ...history,
      { role: 'model', parts: parts.filter((part) => !part.thought) },
      {
        role: 'user',
        parts: parts
          .filter((part) => part.functionCall)
          .map((part) => ({
            functionResponse: {
              id: part.functionCall!.id,
              name: part.functionCall!.name,
              response: { content: `Result for ${part.functionCall!.id}` },
            },
          })),
      },
    ];
  }

  it.each([false, true])(
    'restores each sequential turn and its parallel calls independently (stream=%s)',
    async (stream) => {
      const turns: Turn[] = [
        {
          reasoning: 'Read the two fixtures together.',
          calls: [call('parallel-a', '/a.txt'), call('parallel-b', '/b.txt')],
        },
        { reasoning: 'Compare those results with the third fixture.', calls: [call('sequential-c', '/c.txt')] },
      ];
      const fixture = await replayFixture(stream, turns);
      let history: Content[] = [{ role: 'user', parts: [{ text: 'Compare the three fixtures.' }] }];
      for (const turn of turns) {
        const parts = await fixture.send(history, identity);
        expect(
          parts
            .filter((part) => part.thought)
            .map((part) => part.text)
            .join(''),
        ).toBe(turn.reasoning);
        history = appendToolTurn(history, parts);
      }
      await fixture.send(history, identity);
      expect(fixture.received).toHaveLength(3);
      expect(fixture.received[2].messages.filter((message) => message.role === 'assistant')).toEqual(
        turns.map((turn) => ({
          role: 'assistant',
          content: null,
          reasoning_content: turn.reasoning,
          tool_calls: turn.calls,
        })),
      );
      expect(
        fixture.received[2].messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id),
      ).toEqual(['parallel-a', 'parallel-b', 'sequential-c']);
      expect(history.flatMap((content) => content.parts).some((part) => part.thought)).toBe(false);
    },
  );

  it.each(['conversation', 'missing identity', 'configured model', 'external model', 'endpoint', 'credential'])(
    'does not replay cached reasoning after changing %s',
    async (changedScope) => {
      const turn = {
        reasoning: 'This reasoning belongs only to the original request scope.',
        calls: [call('scoped-call', '/a.txt')],
      };
      const fixture = await replayFixture(true, [turn]);
      const initial: Content[] = [{ role: 'user', parts: [{ text: 'Read the fixture.' }] }];
      const history = appendToolTurn(initial, await fixture.send(initial, identity));
      let scope: Record<string, unknown> = identity;
      if (changedScope === 'conversation') scope = { labels: { cascade_id: 'other-reasoning-cascade' } };
      if (changedScope === 'missing identity') scope = {};
      if (changedScope === 'configured model') fixture.model.name = 'models/other-reasoning-fixture';
      if (changedScope === 'external model') fixture.model.externalModelName = 'other-reasoning-model';
      if (changedScope === 'endpoint') fixture.model.apiUrl += '/other-provider';
      if (changedScope === 'credential') fixture.model.apiKey = 'different-local-fixture-key';
      await fixture.send(history, scope);
      expect(fixture.received).toHaveLength(2);
      const assistant = fixture.received[1].messages.find((message) => message.role === 'assistant')!;
      expect(assistant.reasoning_content || '').toBe('');
      expect(assistant.tool_calls).toEqual(turn.calls);
    },
  );

  it.each(['truncated', 'error'] as const)('does not cache reasoning from a %s stream', async (outcome) => {
    const turn = {
      reasoning: 'Reasoning from an unsuccessful fixture response.',
      calls: [call('failed-call', '/a.txt')],
    };
    const fixture = await replayFixture(true, [turn], outcome);
    const initial: Content[] = [{ role: 'user', parts: [{ text: 'Read the fixture.' }] }];
    await fixture.send(initial, identity, true);
    const history = appendToolTurn(
      initial,
      turn.calls.map((tool) => ({
        functionCall: { id: tool.id, name: tool.function.name, args: JSON.parse(tool.function.arguments) },
      })),
    );
    await fixture.send(history, identity);
    const assistant = fixture.received[1].messages.find((message) => message.role === 'assistant')!;
    expect(assistant.reasoning_content || '').toBe('');
    expect(assistant.tool_calls).toEqual(turn.calls);
  });

  it('clears retained reasoning when custom requests stop', async () => {
    const turn = { reasoning: 'Reasoning retained until the proxy stops.', calls: [call('stop-call', '/a.txt')] };
    const fixture = await replayFixture(true, [turn]);
    const initial: Content[] = [{ role: 'user', parts: [{ text: 'Read the fixture.' }] }];
    const history = appendToolTurn(initial, await fixture.send(initial, identity));
    customRequest.stopCustomRequests();
    await fixture.send(history, identity);
    const assistant = fixture.received[1].messages.find((message) => message.role === 'assistant')!;
    expect(assistant.reasoning_content || '').toBe('');
    expect(assistant.tool_calls).toEqual(turn.calls);
  });
});

describe('buffered Google metadata forwarding', () => {
  it('attributes native quota only to a matching saved credential and its actual request scope', async () => {
    const quota = { buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.4 }] };
    const upstream = await serve((_req, res) => res.end(JSON.stringify(quota)));
    const proxy = await fixture(upstream, false, undefined, undefined, [
      {
        name: 'models/quota-fixture',
        provider: 'google-cloudcode',
        encryptedGoogleAccounts: true,
        googleAccounts: [
          {
            id: 'matched',
            clientId: 'desktop',
            project: 'different-saved-project',
            accessToken: 'forwarding-fixture-token',
          },
          { id: 'unrelated', clientId: 'desktop', project: 'actual-project', accessToken: 'another-token' },
        ],
      },
    ]);
    const response = await post(
      `${proxy.url}/v1internal:retrieveUserQuotaSummary`,
      '{"project":"actual-project"}',
      false,
    );
    expect(response.status).toBe(200);
    const observedScope = {
      accountId: 'matched',
      clientId: 'desktop',
      project: 'actual-project',
      endpoint: 'https://daily-cloudcode-pa.googleapis.com',
    };
    expect(getOfficialQuota(observedScope)?.data).toEqual(quota);
    expect(getOfficialQuota({ ...observedScope, accountId: 'unrelated' })).toBeUndefined();
    expect(getOfficialQuota({ ...observedScope, project: 'different-saved-project' })).toBeUndefined();
    expect(getOfficialQuota({ ...observedScope, endpoint: 'https://cloudcode-pa.googleapis.com' })).toBeUndefined();
  });
  it('delivers a catalogue that completes within the shutdown grace period', async () => {
    let received!: () => void;
    const accepted = new Promise<void>((resolve) => {
      received = resolve;
    });
    let upstreamResponse!: http.ServerResponse;
    const upstream = await serve((_req, res) => {
      upstreamResponse = res;
      received();
    });
    const proxy = await fixture(upstream, false, undefined, 1000);
    const result = post(`${proxy.url}/v1internal:fetchAvailableModels`, '{}', false);
    await accepted;
    const stopping = proxy.stop();
    upstreamResponse.end(JSON.stringify({ models: { 'native-fixture': { displayName: 'Native fixture' } } }));
    const response = await result;
    await stopping;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toMatchObject({
      models: { 'native-fixture': { displayName: 'Native fixture' } },
    });
  });

  it.each(
    ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels', '/v1beta/models'].flatMap((route) =>
      [true, false].map((headers) => ({ route, headers })),
    ),
  )('releases an unfinished upstream socket during shutdown: $route (headers=$headers)', async ({ route, headers }) => {
    let received!: () => void;
    let closed!: () => void;
    const accepted = new Promise<void>((resolve) => {
      received = resolve;
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const upstream = await serve((req, res) => {
      req.socket.once('close', closed);
      if (headers) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"pending":');
      }
      received();
    });
    const proxy = await fixture(upstream, false, undefined, 50);
    const request = http.request(`${proxy.url}${route}`, { method: route === '/v1beta/models' ? 'GET' : 'POST' });
    request.on('error', () => {});
    request.on('response', (response) => {
      response.on('error', () => {});
      response.resume();
    });
    request.end();
    try {
      await accepted;
      await proxy.stop();
      await upstreamClosed;
      expect(proxy.forwarded).toHaveLength(1);
    } finally {
      request.destroy();
    }
  });

  it('discovers a signed-in caller before forwarding exactly one native generation unchanged', async () => {
    const bodies: string[] = [];
    const upstream = await serve((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        bodies.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"candidates":[]}');
      });
    });
    const lookup = vi.fn().mockResolvedValue({ status: 200, body: { paidTier: { usesGcpTos: false } } });
    const proxy = await fixture(upstream, true, lookup);
    const body = JSON.stringify({ model: 'gemini-native', project: 'same-project', request: { contents: [] } });
    const result = await post(proxy.url + '/v1internal:streamGenerateContent', body, true);
    expect(result.status).toBe(200);
    expect(bodies).toEqual([body]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(proxy.forwarded).toHaveLength(1);
    expect(proxy.forwarded[0].target).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
    );
    expect(proxy.forwarded[0].headers.authorization).toBe('Bearer forwarding-fixture-token');
  });

  it('reports a failed route lookup without sending generation to an assumed account endpoint', async () => {
    const upstream = await serve((_request, response) => response.end('unexpected generation'));
    const proxy = await fixture(upstream, true, async () => ({
      status: 429,
      body: { error: { status: 'RESOURCE_EXHAUSTED' } },
    }));
    const result = await post(proxy.url + '/v1internal:streamGenerateContent', '{"model":"native"}', true);
    expect(result.status).toBe(502);
    expect(result.body.toString()).toContain('Could not determine the native Cloud Code account route');
    expect(proxy.forwarded).toEqual([]);
  });

  it('looks up an unknown account route before forwarding the native model catalog', async () => {
    const upstream = await serve((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: { 'native-fixture': { displayName: 'Native fixture' } } }));
      });
    });
    const lookup = vi.fn().mockResolvedValue({ status: 200, body: { paidTier: { usesGcpTos: false } } });
    const proxy = await fixture(upstream, true, lookup);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await post(proxy.url + '/v1internal:fetchAvailableModels', '{"project":"same-project"}', false);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
        models: { 'native-fixture': { displayName: 'Native fixture' } },
      });
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(proxy.forwarded.map((entry) => entry.target)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
  });

  it('still forwards the native model catalog when the account route lookup fails', async () => {
    const upstream = await serve((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: { 'native-fixture': { displayName: 'Native fixture' } } }));
      });
    });
    const proxy = await fixture(upstream, true, async () => {
      throw new Error('lookup unavailable');
    });
    const result = await post(proxy.url + '/v1internal:fetchAvailableModels', '{}', false);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({ models: { 'native-fixture': {} } });
    expect(proxy.forwarded.map((entry) => entry.target)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
  });

  it('logs why the native model catalog is missing instead of failing silently', async () => {
    const upstream = await serve((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end('{"error":{"status":"PERMISSION_DENIED"}}');
      });
    });
    const proxy = await fixture(upstream);
    const result = await post(proxy.url + '/v1internal:fetchAvailableModels', '{}', false);
    expect(result.status).toBe(200);
    expect(proxy.log.warn).toHaveBeenCalledWith(expect.stringContaining('Native model catalog unavailable'));
    expect(proxy.log.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'));
    expect(JSON.stringify(proxy.log.warn.mock.calls)).not.toContain('forwarding-fixture-token');
  });

  it('preserves the IDE tier route across metadata and model-catalog requests', async () => {
    let loadCalls = 0;
    const received: { path: string; authorization?: string; host?: string }[] = [];
    const upstream = await serve((request, response) => {
      request.resume();
      request.on('end', () => {
        received.push({
          path: request.url || '',
          authorization: request.headers.authorization,
          host: request.headers.host,
        });
        const body =
          request.url === '/v1internal:loadCodeAssist'
            ? { paidTier: { usesGcpTos: ++loadCalls === 2 } }
            : { models: {}, agentModelSorts: [] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    const proxy = await fixture(upstream, true);
    const paths = [
      '/v1internal:loadCodeAssist',
      '/v1internal:fetchAvailableModels',
      '/v1internal:loadCodeAssist',
      '/v1internal:fetchAvailableModels',
    ];
    for (const endpoint of paths) {
      const result = await post(proxy.url + endpoint, '{}', true);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString('utf8'))).toBeTypeOf('object');
    }
    const hosts = [
      'cloudcode-pa.googleapis.com',
      'daily-cloudcode-pa.googleapis.com',
      'daily-cloudcode-pa.googleapis.com',
      'cloudcode-pa.googleapis.com',
    ];
    expect(proxy.forwarded.map((entry) => entry.target)).toEqual(
      paths.map((endpoint, index) => `https://${hosts[index]}${endpoint}`),
    );
    expect(received).toEqual(
      paths.map((endpoint, index) => ({
        path: endpoint,
        host: hosts[index],
        authorization: 'Bearer forwarding-fixture-token',
      })),
    );
    for (const entry of proxy.forwarded) {
      expect(entry.headers.host).toBe(new URL(entry.target).host);
      expect(entry.headers.authorization).toBe('Bearer forwarding-fixture-token');
      expect(entry.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it.each([false, true].flatMap((gzip) => [false, true].map((chunkedRequest) => ({ gzip, chunkedRequest }))))(
    'reframes metadata when gzip=$gzip and chunkedRequest=$chunkedRequest',
    async ({ gzip, chunkedRequest }) => {
      const observed: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
      const payload = JSON.stringify({
        message: 'Türkçe metadata ✓',
        endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
        alternate: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
        publicEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      });
      const upstream = await serve((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          observed.push({ path: request.url || '', headers: request.headers, body });
          response.writeHead(203, {
            'content-type': 'application/json; charset=utf-8',
            'transfer-encoding': 'chunked',
            connection: 'close, x-fixture-response-hop',
            'x-fixture-response-hop': 'must-not-forward',
            'keep-alive': 'timeout=5',
            trailer: 'x-fixture-trailer',
            ...(gzip ? { 'content-encoding': 'gzip' } : {}),
          });
          const bytes = gzip ? zlib.gzipSync(payload) : Buffer.from(payload);
          const middle = Math.floor(bytes.length / 2);
          response.write(bytes.subarray(0, middle));
          response.addTrailers({ 'x-fixture-trailer': 'must-not-forward' });
          response.end(bytes.subarray(middle));
        });
      });
      const proxy = await fixture(upstream);
      const requestBody = JSON.stringify({ fixture: true });
      const result = await post(`${proxy.url}/v1internal:loadCodeAssist?fixture=1`, requestBody, chunkedRequest);

      expect(result.status).toBe(203);
      expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(result.headers['transfer-encoding']).toBeUndefined();
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['x-fixture-response-hop']).toBeUndefined();
      expect(result.headers['keep-alive']).toBeUndefined();
      expect(result.headers.trailer).toBeUndefined();
      expect(result.headers['content-length']).toBe(String(result.body.length));
      expect(JSON.parse(result.body.toString('utf8'))).toEqual({
        message: 'Türkçe metadata ✓',
        endpoint: `${proxy.url}/v1internal:generateContent`,
        alternate: `${proxy.url}/v1internal:loadCodeAssist`,
        publicEndpoint: `${proxy.url}/v1beta/models`,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        path: '/v1internal:loadCodeAssist?fixture=1',
        headers: { authorization: 'Bearer forwarding-fixture-token', host: 'daily-cloudcode-pa.googleapis.com' },
        body: requestBody,
      });
      expect(observed[0].headers['accept-encoding']).toBeUndefined();
      expect(observed[0].headers['transfer-encoding']).toBeUndefined();
      expect(observed[0].headers['x-fixture-request-hop']).toBeUndefined();
      expect(observed[0].headers['content-length']).toBe(String(Buffer.byteLength(requestBody)));
      expect(proxy.forwarded).toHaveLength(1);
      expect(proxy.forwarded[0].target).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist?fixture=1',
      );
      expect(proxy.forwarded[0].headers.connection).toBeUndefined();
    },
  );
});
