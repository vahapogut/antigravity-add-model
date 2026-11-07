import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createModelManager } from '../modelManagement';
import { clearDiagnostics, getDiagnostics } from '../diagnostics';
import { getGooglePoolStatus, resetGoogleAccountState } from '../googleAccounts';

const directories: string[] = [];
const servers: http.Server[] = [];
const codec = {
  encryptString: (value: string) => `sealed:${value}`,
  decryptString: (value: string) => value.replace(/^sealed:/, ''),
};
function manager() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-probe-'));
  directories.push(directory);
  return createModelManager(directory, codec, async () => {});
}
async function fixture(reply: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    reply(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(clearDiagnostics);
afterEach(async () => {
  resetGoogleAccountState();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('explicit generation test', () => {
  it.each(['openai', 'anthropic', 'google'] as const)(
    'uses the production %s format with a short fixed prompt and measured diagnostics',
    async (format) => {
      let captured: any;
      const url = await fixture((req, res, body) => {
        captured = { url: req.url, body, headers: req.headers };
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            format === 'openai'
              ? {
                  choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 8, completion_tokens: 1 },
                }
              : format === 'anthropic'
                ? {
                    content: [{ type: 'text', text: 'OK' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 8, output_tokens: 1 },
                  }
                : {
                    candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 },
                  },
          ),
        );
      });
      const service = manager();
      service.saveModel({
        name: 'models/probe',
        provider: format,
        apiFormat: format,
        apiUrl: url,
        apiKey: 'private-key',
        externalModelName: 'test-model',
        maxRetries: 4,
        extraBody: { secret: 'private-prompt' },
      });
      const result = await service.testGeneration(service.store.list()[0]);
      expect(result.success).toBe(true);
      expect(JSON.stringify(captured.body)).toContain('Reply with OK.');
      expect(JSON.stringify(captured.body)).not.toContain('private-');
      expect(captured.body.max_tokens ?? captured.body.generationConfig?.maxOutputTokens).toBe(1024);
      expect(
        captured.headers.authorization || captured.headers['x-api-key'] || captured.headers['x-goog-api-key'],
      ).toContain('private-key');
      expect(getDiagnostics().requests[0]).toMatchObject({
        kind: 'generation-test',
        outcome: 'succeeded',
        inputTokens: 8,
        outputTokens: 1,
      });
      expect(getDiagnostics().recentModels).toEqual([]);
    },
  );

  it('does not retry or expose provider error bodies', async () => {
    let attempts = 0;
    const url = await fixture((_req, res) => {
      attempts++;
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: 'private-key private-prompt' } }));
    });
    const service = manager();
    const result = await service.testGeneration({
      provider: 'openai',
      apiUrl: url,
      externalModelName: 'test',
      apiKey: 'key',
    });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ success: false, status: 503 });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(getDiagnostics().requests[0]).toMatchObject({ outcome: 'failed', status: 503 });
  });

  it('rejects a successful HTTP response without generated text', async () => {
    const url = await fixture((_req, res) =>
      res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })),
    );
    const result = await manager().testGeneration({ provider: 'openai', apiUrl: url, externalModelName: 'test' });
    expect(result).toMatchObject({ success: false, status: 502 });
    expect(getDiagnostics().requests[0]).toMatchObject({ outcome: 'failed', status: 502 });
    expect(getDiagnostics().summary).toMatchObject({ failed: 1, succeeded: 0 });
  });

  it('does not mistake a reasoning-only response for a completed generation test', async () => {
    const url = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: '', reasoning_content: 'Only internal reasoning' }, finish_reason: 'length' },
          ],
        }),
      ),
    );
    const result = await manager().testGeneration({ provider: 'openai', apiUrl: url, externalModelName: 'test' });
    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result).toHaveProperty('error', expect.stringContaining('1024-token test output limit'));
    expect(getDiagnostics().requests[0]).toMatchObject({ outcome: 'failed', status: 502 });
    expect(getDiagnostics().summary).toMatchObject({ failed: 1, succeeded: 0 });
  });

  it('keeps a Google account eligible when its accepted response only exhausts the short test budget', async () => {
    const url = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          response: {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'Only internal reasoning', thought: true }] },
                finishReason: 'MAX_TOKENS',
              },
            ],
          },
        }),
      ),
    );
    const result = await manager().testGeneration({
      provider: 'google-cloudcode',
      apiFormat: 'google',
      apiUrl: url,
      externalModelName: 'gemini-test',
      googleAccounts: [{ id: 'healthy-probe-account', accessToken: 'test-access-token' }],
    });
    expect(result).toMatchObject({ success: false, status: 502 });
    expect(getDiagnostics().requests[0]).toMatchObject({ outcome: 'failed', status: 502 });
    const account = getGooglePoolStatus().find((entry) => entry.id === 'healthy-probe-account');
    expect(account).toMatchObject({
      inFlight: 0,
      requests: 1,
      succeeded: 1,
      failed: 0,
      lastStatus: 200,
      modelCooldowns: [],
    });
  });
});
