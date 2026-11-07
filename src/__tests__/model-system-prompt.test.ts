import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CustomModel } from '../proxy';
import { appendModelSystemPrompt, type GeminiBody } from '../proxy/requestOptions';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';
import { validateCustomModel } from '../schemaValidator';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

function model(fields: Partial<CustomModel> = {}): CustomModel {
  return {
    name: `models/${randomUUID()}`,
    displayName: 'test',
    description: '',
    provider: 'openai',
    apiKey: 'test-only-key',
    apiUrl: 'https://example.invalid/v1',
    externalModelName: 'test-model',
    maxRetries: 0,
    ...fields,
  };
}
function request(): GeminiBody {
  return {
    systemInstruction: { role: 'user', parts: [{ text: 'IDE_RULES' }] },
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  stopCustomRequests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
afterAll(stopCleanupInterval);
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function openaiSuccess(res: http.ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'Merhaba.' }, finish_reason: 'stop' }] }));
}

describe('per-model system prompt (issue #36)', () => {
  it('appends the model prompt after the IDE system instruction without changing the input', () => {
    const body = request();
    const original = structuredClone(body);
    const result = appendModelSystemPrompt(body, '  Always answer in Turkish.  ');
    expect(result.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'IDE_RULES' }, { text: 'Always answer in Turkish.' }],
    });
    expect(body).toEqual(original);
  });

  it('creates a system instruction when the request has none', () => {
    const body: GeminiBody = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
    expect(appendModelSystemPrompt(body, 'Be brief.').systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });

  it.each([undefined, '', '   '])('leaves the request untouched for an empty prompt %j', (prompt) => {
    const body = request();
    expect(appendModelSystemPrompt(body, prompt)).toBe(body);
  });

  it('validates the saved field', () => {
    expect(validateCustomModel(model({ systemPrompt: 'Always answer in Turkish.' })).valid).toBe(true);
    expect(validateCustomModel({ ...model(), systemPrompt: 42 })).toMatchObject({ valid: false });
    expect(validateCustomModel(model({ systemPrompt: 'x'.repeat(20_001) }))).toMatchObject({ valid: false });
  });

  it('sends the IDE instruction first and the model prompt after it to an OpenAI-compatible provider', async () => {
    const captured: Record<string, unknown>[] = [];
    const upstream = await serve(async (req, res) => {
      captured.push(await readBody(req));
      openaiSuccess(res);
    });
    const config = model({ apiUrl: upstream, systemPrompt: 'Always answer in Turkish.' });
    const proxy = await serve((_req, res) => {
      void runCustomModelRequest(res, config, request(), false, [config], false);
    });
    expect((await fetch(proxy)).status).toBe(200);
    const messages = captured[0].messages as { role: string; content: string }[];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('IDE_RULES');
    expect(messages[0].content.indexOf('IDE_RULES')).toBeLessThan(
      messages[0].content.indexOf('Always answer in Turkish.'),
    );
  });

  it('uses each fallback model’s own prompt instead of the primary prompt', async () => {
    const captured: Record<string, unknown>[] = [];
    const primaryUrl = await serve(async (req, res) => {
      captured.push(await readBody(req));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'primary unavailable' } }));
    });
    const fallbackUrl = await serve(async (req, res) => {
      captured.push(await readBody(req));
      openaiSuccess(res);
    });
    const fallback = model({ apiUrl: fallbackUrl, systemPrompt: 'FALLBACK_PROMPT' });
    const primary = model({ apiUrl: primaryUrl, systemPrompt: 'PRIMARY_PROMPT', fallbackModels: [fallback.name] });
    const proxy = await serve((_req, res) => {
      void runCustomModelRequest(res, primary, request(), false, [primary, fallback], false);
    });
    expect((await fetch(proxy)).status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(JSON.stringify(captured[0].messages)).toContain('PRIMARY_PROMPT');
    expect(JSON.stringify(captured[1].messages)).toContain('FALLBACK_PROMPT');
    expect(JSON.stringify(captured[1].messages)).not.toContain('PRIMARY_PROMPT');
  });
});
