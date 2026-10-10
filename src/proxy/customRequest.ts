import * as http from 'http';
import * as https from 'https';
import { createHash, randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { CustomModel } from '../proxy';
import { resolveApiFormat } from '../providers';
import { acquireGoogleAccount, GoogleAccountError, GoogleAccountLease } from '../googleAccounts';
import * as registry from './registry';
import { CircuitBreaker } from './circuitBreaker';
import { applyRequestOptions, GeminiBody, parseRetryAfter, trimContext } from './requestOptions';
import { activeStreamContexts, modelReasoningContent, modelToolCallIds, stateTimestamps } from './shared';
import { collectToolSchemas } from './translators/utils';

const circuits = new CircuitBreaker();
const controllers = new Set<AbortController>();
const counts = {
  requests: 0,
  active: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  upstreamAttempts: 0,
  retries: 0,
  fallbacks: 0,
  circuitSkips: 0,
  accountSwitches: 0,
};
export function getProxyMetrics() {
  return { ...counts, circuits: circuits.snapshot() };
}
export function stopCustomRequests(): void {
  for (const controller of controllers) controller.abort();
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retryable = true,
    readonly retryAfter = 0,
    readonly mayFallback = true,
  ) {
    super(message);
  }
}
function asUpstreamError(error: unknown): UpstreamError {
  if (error instanceof GoogleAccountError) return new UpstreamError(error.message, error.status, false);
  return error instanceof UpstreamError ? error : new UpstreamError('Upstream connection failed.');
}
function clearRequestState(key: string): void {
  activeStreamContexts.delete(key);
  modelReasoningContent.delete(key);
  modelToolCallIds.delete(key);
  for (const timestamps of Object.values(stateTimestamps)) timestamps.delete(key);
}
function envelope(value: unknown, cloud: boolean): unknown {
  return cloud ? { response: value, traceId: '', metadata: {} } : value;
}
function validateToolArguments(value: unknown): void {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') parsed = JSON.parse(value || '{}');
  } catch {
    throw new UpstreamError('Upstream returned incomplete tool arguments.', 502, false, 0, false);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new UpstreamError('Upstream returned invalid tool arguments.', 502, false, 0, false);
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function waitForDrain(res: http.ServerResponse): Promise<void> {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const drain = () => {
      res.removeListener('close', closed);
      resolve();
    };
    const closed = () => {
      res.removeListener('drain', drain);
      reject(new Error('Cancelled'));
    };
    res.once('drain', drain);
    res.once('close', closed);
  });
}

export function buildFallbackChain(primary: CustomModel, allModels: CustomModel[]): CustomModel[] {
  const names = new Set([primary.name]);
  const chain = [primary];
  for (const name of primary.fallbackModels || []) {
    const model = allModels.find((candidate) => candidate.name === name && candidate.enabled !== false);
    if (model && !names.has(name)) {
      names.add(name);
      chain.push(model);
    }
  }
  return chain;
}

/** The sole retry/fallback owner; nothing is retried after any model output was received. */
export async function runCustomModelRequest(
  res: http.ServerResponse,
  primary: CustomModel,
  originalBody: GeminiBody,
  isStream: boolean,
  allModels: CustomModel[],
  cloudEnvelope = true,
): Promise<void> {
  const toolSchemas = collectToolSchemas(originalBody);
  const controller = new AbortController();
  const { signal } = controller;
  const requestId = randomUUID();
  controllers.add(controller);
  counts.requests += 1;
  counts.active += 1;
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  let completed = false;
  let upstreamOutput = false;
  const deadline = Date.now() + (primary.retryBudgetMs ?? Math.max(primary.timeout ?? 120_000, 120_000));
  let failure = new UpstreamError('No configured model is currently available.', 503);

  const writeCandidate = (candidate: unknown) => {
    if (signal.aborted || res.destroyed) throw new Error('Cancelled');
    if (!res.headersSent)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
    res.write(`data: ${JSON.stringify(envelope({ candidates: [candidate] }, cloudEnvelope))}\n\n`);
  };

  try {
    const chain = buildFallbackChain(primary, allModels);
    modelLoop: for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
      const model = chain[modelIndex];
      if (signal.aborted) break;
      if (Date.now() >= deadline) {
        failure = new UpstreamError('Request retry budget exhausted.', 504, false);
        break;
      }
      // Include transport configuration so editing a broken endpoint does not retain its open circuit.
      const circuitKey = JSON.stringify([model.name, model.apiUrl, model.apiFormat || model.provider]);
      if (!circuits.acquire(circuitKey, model.circuitBreaker)) {
        counts.circuitSkips += 1;
        continue;
      }
      if (modelIndex > 0) counts.fallbacks += 1;
      let modelFailed = false;
      const retries = Math.min(5, Math.max(0, model.maxRetries ?? 3));
      const cloudCode = model.provider === 'google-cloudcode';
      const accountCount = cloudCode
        ? (model.googleAccounts || []).filter((account) => account.enabled !== false).length
        : 0;
      const attemptsAllowed = retries + Math.max(0, accountCount - 1);
      for (let attempt = 0; attempt <= attemptsAllowed; attempt++) {
        const stateKey = randomUUID();
        let request: http.ClientRequest | undefined;
        let accountLease: GoogleAccountLease | undefined;
        let totalTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => request?.destroy(new Error('Cancelled'));
        try {
          if (signal.aborted) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new UpstreamError('Request retry budget exhausted.', 504, false);
          const format = resolveApiFormat(model.provider, model.apiFormat);
          const externalName = model.externalModelName || model.name.replace(/^models\//, '');
          if (cloudCode) {
            const identity = originalBody.sessionId || originalBody.conversationId;
            accountLease = await acquireGoogleAccount(
              model.name,
              model.googleAccounts || [],
              model.googlePool,
              typeof identity === 'string' ? identity : undefined,
            );
            if (signal.aborted) break;
          }
          let payload: Record<string, unknown>;
          let url: URL;
          let headers: registry.ProviderHeaders;
          try {
            const outputBudget =
              model.maxOutputTokens ??
              Number(
                originalBody.generationConfig?.maxOutputTokens ||
                  (model.contextWindow ? Math.min(4000, Math.max(1, Math.floor(model.contextWindow / 4))) : 0),
              );
            const body = trimContext(originalBody, model.contextWindow, outputBudget);
            const effectiveModel = outputBudget ? { ...model, maxOutputTokens: outputBudget } : model;
            payload = applyRequestOptions(
              registry.translateRequest(model.provider, body, externalName, format, stateKey) as Record<
                string,
                unknown
              >,
              effectiveModel,
              format,
              isStream,
            );
            const target =
              cloudCode || model.rawUrl
                ? model.apiUrl
                : registry.getProviderUrl(
                    model.apiUrl,
                    externalName,
                    isStream,
                    registry.getTranslator(model.provider, format),
                  );
            url = new URL(target);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported endpoint protocol');
            headers = registry.getProviderHeaders(model.provider, cloudCode ? '' : model.apiKey, format);
            if (accountLease) {
              url.pathname = `/v1internal:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
              url.search = isStream ? '?alt=sse' : '';
              headers.Authorization = `Bearer ${accountLease.account.accessToken}`;
              headers['User-Agent'] = 'antigravity';
              const project = accountLease.account.project || model.googleProject;
              payload = { model: externalName, ...(project ? { project } : {}), request: payload };
            }
            if (['opencode', 'zen', 'opencode-go'].includes(model.provider)) {
              const identity = originalBody.sessionId || originalBody.conversationId;
              headers['x-opencode-session'] = typeof identity === 'string' ? identity : requestId;
            }
            if (model.gateway) {
              const identity = originalBody.conversationId || originalBody.sessionId;
              if (typeof identity === 'string' && identity.trim()) {
                // Stable across turns and safe as a header, even when callers use Unicode/control characters.
                headers['x-antigravity-conversation-id'] = createHash('sha256').update(identity).digest('hex');
              }
            }
            for (const [key, value] of Object.entries(model.customHeaders || {})) {
              if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
                throw new Error('Reserved HTTP header');
              if (cloudCode && /^authorization$/i.test(key))
                throw new Error('Google pool authorization comes from the selected account');
              http.validateHeaderName(key);
              http.validateHeaderValue(key, value);
              headers[key] = value;
            }
          } catch (error) {
            throw new UpstreamError(`Invalid model configuration: ${(error as Error).message}`, 400, false, 0, false);
          }
          counts.upstreamAttempts += 1;
          const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
            request = (url.protocol === 'https:' ? https : http).request(
              url,
              { method: 'POST', headers, rejectUnauthorized: !model.allowUnauthorized },
              resolve,
            );
            request.once('error', reject);
            request.setTimeout(model.idleTimeout ?? 30_000, () =>
              request?.destroy(new UpstreamError('Upstream idle timeout.', 504)),
            );
            totalTimer = setTimeout(
              () => request?.destroy(new UpstreamError('Upstream request timeout.', 504)),
              Math.min(model.timeout ?? 120_000, remaining),
            );
            signal.addEventListener('abort', abort, { once: true });
            request.end(JSON.stringify(payload));
          });
          const status = upstream.statusCode || 502;
          if (status < 200 || status >= 300) {
            const retryAfter = parseRetryAfter(upstream.headers['retry-after']);
            upstream.destroy();
            throw new UpstreamError(
              `Upstream returned HTTP ${status}.`,
              status,
              status === 408 || status === 429 || status >= 500,
              retryAfter,
              status !== 400 && status !== 422,
            );
          }

          if (isStream && String(upstream.headers['content-type']).includes('text/event-stream')) {
            const decoder = new StringDecoder('utf8');
            let buffer = '';
            let dataLines: string[] = [];
            let emitted = false;
            let finalReason = false;
            let terminal = false;
            const event = () => {
              const data = dataLines.join('\n');
              dataLines = [];
              if (!data) return;
              if (data.trim() === '[DONE]') {
                terminal = true;
                return;
              }
              let chunk: Record<string, any>;
              try {
                chunk = JSON.parse(data);
              } catch {
                throw new UpstreamError('Upstream sent malformed SSE JSON.');
              }
              if (chunk.error || chunk.type === 'error') throw new UpstreamError('Upstream reported a stream error.');
              if (cloudCode && chunk.response) chunk = chunk.response;
              const delta = chunk.choices?.[0]?.delta;
              if (
                delta?.content ||
                delta?.reasoning_content ||
                delta?.reasoning ||
                delta?.tool_calls?.length ||
                chunk.content_block?.type === 'tool_use' ||
                chunk.delta?.text ||
                chunk.delta?.thinking ||
                chunk.delta?.partial_json ||
                chunk.candidates?.[0]?.content?.parts?.length
              )
                upstreamOutput = true;
              if (
                chunk.type === 'message_stop' ||
                chunk.choices?.[0]?.finish_reason ||
                chunk.candidates?.[0]?.finishReason
              )
                terminal = true;
              if (
                (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'tool_use') ||
                chunk.choices?.[0]?.finish_reason
              ) {
                const pendingTools = activeStreamContexts.get(stateKey)?.toolCalls || {};
                if (format === 'openai') {
                  // A terminal delta can contain the last argument fragment (or a whole call).
                  // Validate the completed snapshot before translation consumes/deletes the context.
                  const argumentsByIndex = new Map(
                    Object.entries(pendingTools).map(([index, tool]) => [Number(index), tool.arguments]),
                  );
                  for (const tool of delta?.tool_calls || []) {
                    const index = tool.index ?? 0;
                    argumentsByIndex.set(index, (argumentsByIndex.get(index) || '') + (tool.function?.arguments || ''));
                  }
                  for (const args of argumentsByIndex.values()) validateToolArguments(args);
                } else {
                  for (const tool of Object.values(pendingTools)) validateToolArguments(tool.arguments);
                }
              }
              const mapped = registry.translateStreamChunk(
                model.provider,
                chunk,
                stateKey,
                format,
                stateKey,
                toolSchemas,
              ) as {
                content?: { parts?: unknown[] };
                finishReason?: string;
              } | null;
              if (mapped) {
                if (mapped.content?.parts?.length) emitted = true;
                if (mapped.finishReason && mapped.finishReason !== 'OTHER') finalReason = true;
                // A role-only or empty completion must not commit headers and prevent fallback.
                if (emitted) writeCandidate(mapped);
              }
            };
            const drain = () => {
              let index: number;
              while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/, '');
                buffer = buffer.slice(index + 1);
                if (!line) event();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
              }
            };
            for await (const bytes of upstream) {
              if (signal.aborted) throw new Error('Cancelled');
              buffer += decoder.write(bytes as Buffer);
              if (buffer.length + dataLines.join('').length > 2 * 1024 * 1024)
                throw new UpstreamError('Upstream SSE event is too large.', 502, false);
              drain();
              await waitForDrain(res);
            }
            buffer += decoder.end();
            if (buffer) buffer += '\n';
            drain();
            event();
            if (!emitted) throw new UpstreamError('Upstream returned an empty stream.');
            if (!terminal) throw new UpstreamError('Upstream stream ended before completion.', 502, false);
            if (!finalReason) writeCandidate({ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 });
          } else {
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const bytes of upstream) {
              size += bytes.length;
              if (size > 20 * 1024 * 1024) throw new UpstreamError('Upstream response exceeds 20 MB.', 502, false);
              chunks.push(bytes as Buffer);
            }
            let parsed: Record<string, any>;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              throw new UpstreamError('Upstream returned invalid JSON.');
            }
            if (parsed.error) throw new UpstreamError('Upstream returned an error response.');
            if (cloudCode && parsed.response) parsed = parsed.response;
            if (
              (format === 'openai' && !parsed.choices?.[0]?.message) ||
              (format === 'anthropic' && !Array.isArray(parsed.content))
            )
              throw new UpstreamError('Upstream returned an invalid completion.');
            if (parsed.choices?.[0]?.message?.tool_calls?.length) {
              upstreamOutput = true;
              for (const tool of parsed.choices[0].message.tool_calls) validateToolArguments(tool.function?.arguments);
            }
            // Some compatible endpoints return a complete JSON response even when stream=true.
            const mapped = registry.translateResponse(model.provider, parsed, stateKey, format, toolSchemas) as {
              candidates?: unknown[];
            };
            if (!mapped?.candidates?.length) throw new UpstreamError('Upstream returned no candidates.');
            if (isStream) {
              for (const candidate of mapped.candidates) writeCandidate(candidate);
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(envelope(mapped, cloudEnvelope)));
            }
          }
          circuits.succeed(circuitKey);
          completed = true;
          counts.succeeded += 1;
          res.end();
          return;
        } catch (error) {
          failure = asUpstreamError(error);
          accountLease?.release({ status: failure.status, retryAfterMs: failure.retryAfter });
          if (signal.aborted) {
            circuits.cancel(circuitKey);
            break modelLoop;
          }
          if (res.headersSent || upstreamOutput) {
            circuits.fail(circuitKey, model.circuitBreaker);
            break modelLoop;
          }
          if (
            accountLease &&
            attempt < accountCount - 1 &&
            [401, 403, 408, 429, 500, 502, 503, 504].includes(failure.status)
          ) {
            counts.accountSwitches += 1;
            continue;
          }
          if (failure.retryable && attempt < retries && Date.now() < deadline) {
            counts.retries += 1;
            // Tear down the old attempt before waiting; timeout and error cannot each schedule a retry.
            request?.destroy();
            if (totalTimer) clearTimeout(totalTimer);
            signal.removeEventListener('abort', abort);
            await delay(Math.min(failure.retryAfter || 500 * 2 ** attempt, Math.max(1, deadline - Date.now())), signal);
          } else {
            modelFailed = true;
            break;
          }
        } finally {
          if (totalTimer) clearTimeout(totalTimer);
          signal.removeEventListener('abort', abort);
          request?.destroy();
          accountLease?.release();
          clearRequestState(stateKey);
        }
      }
      if (modelFailed) circuits.fail(circuitKey, model.circuitBreaker);
      else circuits.cancel(circuitKey);
      if (!failure.mayFallback) break;
    }
    if (!signal.aborted && !res.writableEnded && !res.destroyed) {
      if (res.headersSent)
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: { message: failure.message, code: failure.status } })}\n\n`,
        );
      else {
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({ error: { message: failure.message } }));
      }
      res.end();
    }
  } catch {
    if (!signal.aborted && !res.writableEnded && !res.destroyed) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Model request failed.' } }));
    }
  } finally {
    res.removeListener('close', onClose);
    controllers.delete(controller);
    counts.active -= 1;
    if (!completed) {
      if (signal.aborted) counts.cancelled += 1;
      else counts.failed += 1;
    }
  }
}
