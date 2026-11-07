import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { CustomModel } from './proxy';
import { runCustomModelRequest } from './proxy/customRequest';

/**
 * Output budget for "Test generation". Reasoning models (for example Qwen3 or
 * DeepSeek-R1 behind llama.cpp) spend tokens on reasoning before the answer, so a
 * tiny budget fails them even though they work in chat (issue #42). Other models
 * still stop after replying "OK", so the larger limit does not raise their cost.
 */
export const GENERATION_PROBE_OUTPUT_TOKENS = 1024;

/** A bounded response sink exercises the real request path without opening another listening port. */
class ProbeResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  bytes = 0;
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.bytes += chunk.length;
    if (this.bytes > 256 * 1024) return done(new Error('Generation test response exceeds limit'));
    done();
  }
}

/** Explicitly invoked only. One short generation; no retries, tools, user prompt or fallback models. */
export async function runGenerationProbe(input: CustomModel) {
  const startedAt = Date.now();
  const response = new ProbeResponse();
  response.on('error', () => {});
  const model = {
    ...input,
    enabled: true,
    maxRetries: 0,
    fallbackModels: [],
    timeout: 30000,
    retryBudgetMs: 30000,
    maxOutputTokens: GENERATION_PROBE_OUTPUT_TOKENS,
    extraBody: undefined,
    thinkingBudget: undefined,
    circuitBreaker: { enabled: false },
  } as CustomModel;
  await runCustomModelRequest(
    response as unknown as ServerResponse,
    model,
    {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: { maxOutputTokens: GENERATION_PROBE_OUTPUT_TOKENS },
    },
    false,
    [model],
    false,
    'generation-test',
  );
  if (response.statusCode < 200 || response.statusCode >= 300 || response.errored)
    return {
      success: false,
      status: response.statusCode,
      error: `Generation failed (HTTP ${response.statusCode}). Check model access, provider quota, configuration and the ${GENERATION_PROBE_OUTPUT_TOKENS}-token test output limit.`,
    };
  return {
    success: true,
    status: response.statusCode,
    message: `Generation succeeded (HTTP ${response.statusCode}, ${Date.now() - startedAt} ms).`,
  };
}
