/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
}

interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

// ─── Imports ──────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let proxyPort = 0;

// Shared cross-turn state
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
  startCleanupInterval,
  stopCleanupInterval,
} from './proxy/shared';

// Model configuration & capability detection
import { detectModelCapabilities, detectModelCapabilitiesByName } from './proxy/modelUtils';

// Provider translator registry (auto-discovers translators from proxy/translators/)
import * as registry from './proxy/registry';

// Dynamic imports (stays require for Electron-specific modules)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoStore = require('./cryptoStore');

// ─── Model Helpers ────────────────────────────────────────────────────────

function generateModelPlaceholderId(model: CustomModel): string {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash; // Force 32-bit integer
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

function getCustomModelsPath(): string {
  const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'custom_models.json');
}

function toSlug(model: CustomModel): string {
  return (
    'custom-' +
    (model.externalModelName || model.name)
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

// ─── Model Loading ────────────────────────────────────────────────────────

function loadCustomModels(): CustomModel[] {
  const filePath = getCustomModelsPath();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateCustomModel } = require('./schemaValidator');

  if (!fs.existsSync(filePath)) {
    const defaultModels = {
      models: [
        {
          name: 'models/gpt-4o',
          displayName: 'GPT-4o (OpenAI via Proxy)',
          description: 'OpenAI GPT-4o model redirected through proxy',
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          externalModelName: 'gpt-4o',
        },
        {
          name: 'models/claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
          description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
          apiUrl: 'https://api.anthropic.com/v1/messages',
          externalModelName: 'claude-3-5-sonnet-latest',
        },
        {
          name: 'models/llama3',
          displayName: 'Llama 3 (Local Ollama)',
          description: 'Local Ollama Llama 3 model run on your machine',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
          externalModelName: 'llama3',
        },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      (defaultModels.models as CustomModel[]).forEach((m) => {
        (m as unknown as Record<string, unknown>).encrypted = false;
      });
      const encrypted = cryptoStore.encryptModels(defaultModels.models);
      fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
    } catch (e) {
      log.error('[Proxy] Failed to write default custom_models.json', e);
    }
    return cryptoStore.decryptModels(defaultModels.models);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModel[] };
    const models = parsed.models || [];

    // Auto-migration check
    const needsMigration = models.some(
      (m) =>
        !m.encrypted &&
        m.apiKey &&
        m.apiKey !== 'none' &&
        !m.apiKey.startsWith('enc:') &&
        !m.apiKey.startsWith('fallback:'),
    );
    if (needsMigration) {
      log.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
      cryptoStore.backupFile(filePath);
      const encryptedModels = cryptoStore.encryptModels(models);
      try {
        fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), 'utf-8');
        log.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
        return cryptoStore.decryptModels(encryptedModels);
      } catch (err) {
        log.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
      }
    }

    const decrypted = cryptoStore.decryptModels(models) as CustomModel[];

    // Validate all models
    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        validModels.push(decrypted[i]);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    if (validModels.length < decrypted.length) {
      log.info(
        `[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`,
      );
    }

    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse custom_models.json', e);
    return [];
  }
}

// ─── Google Proxy ─────────────────────────────────────────────────────────

function proxyToGoogle(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer): void {
  const isCloudCodeUrl = req.url!.includes('v1internal') || req.url!.includes('daily-cloudcode');
  const targetUrl = isCloudCodeUrl
    ? 'https://daily-cloudcode-pa.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers as Record<string, string | string[] | undefined>),
  };
  headers['host'] = isCloudCodeUrl ? 'daily-cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';
  delete headers['connection'];
  delete headers['keep-alive'];

  const isGeneration = req.url!.includes('generateContent') || req.url!.includes('streamGenerateContent');
  const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;

  if (shouldBufferAndModify) {
    delete headers['accept-encoding'];
  }

  const options: https.RequestOptions = {
    method: req.method,
    headers: headers as Record<string, string>,
  };

  const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
    // P0-5: Timeout for Google proxy requests (60s)
    proxyReq.setTimeout(60_000, () => {
      log.error('[Proxy] Google proxy request timed out after 60s');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
      }
    });

    if (shouldBufferAndModify) {
      const responseChunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const fullResBody = Buffer.concat(responseChunks);
        let text: string;
        const encoding = proxyRes.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            const zlib = require('zlib');
            text = zlib.gunzipSync(fullResBody).toString('utf-8');
          } catch (e) {
            log.error('[Proxy] gunzipSync failed:', e);
            text = fullResBody.toString('utf-8');
          }
        } else {
          text = fullResBody.toString('utf-8');
        }

        log.info(
          `[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`,
        );
        // P0-3: Response body content is NOT logged to disk. Only metadata.

        const proxyHost = req.headers.host || 'localhost';
        text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);

        const modifiedHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
        delete modifiedHeaders['content-encoding'];

        const modifiedBuffer = Buffer.from(text, 'utf-8');
        modifiedHeaders['content-length'] = String(modifiedBuffer.length);

        res.writeHead(proxyRes.statusCode || 200, modifiedHeaders as Record<string, string>);
        res.end(modifiedBuffer);
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers as Record<string, string>);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    log.error('[Proxy] Google Forwarding Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
  });

  if (reqBody) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ─── Custom Model Request Handler ─────────────────────────────────────────

/**
 * Parses the Retry-After header from upstream responses (RFC 7231 §7.1.3).
 * Returns delay in milliseconds, or 0 if no valid header is present.
 */
function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
  const val = headers['retry-after'];
  if (!val) return 0;

  const raw = Array.isArray(val) ? val[0] : val;
  if (!raw) return 0;

  // Try delta-seconds (e.g. "120")
  const seconds = parseInt(raw.trim(), 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return 0;
}

function handleCustomModelRequest(
  res: http.ServerResponse,
  model: CustomModel,
  geminiBody: GeminiRequestBody,
  isStream: boolean,
  retryCount = 0,
): void {
  // P3-18: Configurable max retries per model (default 3, min 0, max 5)
  const MAX_RETRIES = Math.min(Math.max(model.maxRetries ?? 3, 0), 5);
  const REQUEST_TIMEOUT_MS = model.timeout || 120_000;

  const provider = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;

  const payload = registry.translateRequest(provider, geminiBody, model.externalModelName);
  const headers = registry.getProviderHeaders(provider, model.apiKey);

  if (isStream && registry.supportsStreaming(provider)) {
    (payload as Record<string, unknown>).stream = true;
  }

  let finalUrlStr = model.apiUrl;
  // P3-15: Google AI Studio uses dynamic URL construction for streaming vs non-streaming
  // P3-16: Ollama uses URL normalization for default port and endpoint
  if (provider === 'google' || provider === 'ollama') {
    const providerTranslator = registry.getTranslator(provider);
    finalUrlStr = registry.getProviderUrl(finalUrlStr, model.externalModelName, isStream, providerTranslator);
  } else if (provider === 'openai' || model.provider === 'custom' || model.provider === 'openrouter') {
    const urlLower = finalUrlStr.toLowerCase();
    if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
      if (finalUrlStr.endsWith('/v1')) {
        finalUrlStr += '/chat/completions';
      } else if (!finalUrlStr.endsWith('/')) {
        finalUrlStr += '/v1/chat/completions';
      } else {
        finalUrlStr += 'v1/chat/completions';
      }
    }
  }
  const url = new URL(finalUrlStr);
  const client = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    headers: headers as Record<string, string>,
  };

  // P0-2: SSL bypass ONLY when user explicitly opts in via allowUnauthorized.
  // Custom providers no longer bypass SSL automatically.
  if (model.allowUnauthorized) {
    log.warn(
      `[Proxy] SSL verification DISABLED for ${model.name} (allowUnauthorized=true). Connection is vulnerable to MITM.`,
    );
    (options as Record<string, unknown>).rejectUnauthorized = false;
  }

  log.info(
    `[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`,
  );

  const request = client.request(url, options, (apiRes) => {
    apiRes.on('error', (err) => {
      log.error(`[Proxy] Upstream stream error for ${model.name}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream connection error: ' + err.message } }));
      } else {
        res.end();
      }
    });

    if (isStream) {
      // Check for API errors BEFORE writing streaming headers
      if (apiRes.statusCode! >= 400) {
        let errorBody = '';
        apiRes.on('data', (chunk: Buffer) => errorBody += chunk.toString());
        apiRes.on('end', () => {
          log.error(`[Proxy] Stream API error (${apiRes.statusCode}) for ${model.name}: ${errorBody.substring(0, 300)}`);
          if (retryCount < MAX_RETRIES) {
            log.warn(`[Proxy] Stream error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(errorBody);
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let buffer = '';
      apiRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);

              if (mapped) {
                const cloudCodeResponse = {
                  response: { candidates: [mapped] },
                  traceId: '',
                  metadata: {},
                };
                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
              }
            } catch (err) {
              // Partial/invalid JSON chunks are normal during streaming; debug-level only
              log.debug(`[Proxy] Stream chunk parse warning for ${model.name}:`, (err as Error).message);
            }
          }
        }
      });

      apiRes.on('end', () => {
        if (buffer.trim().startsWith('data: ')) {
          const dataStr = buffer.trim().substring(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);
              if (mapped) {
                const cloudCodeResponse = {
                  response: { candidates: [mapped] },
                  traceId: '',
                  metadata: {},
                };
                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
              }
            } catch (e) {
              log.debug(`[Proxy] Stream buffer drain parse warning for ${model.name}:`, (e as Error).message);
            }
          }
        }

        const finalChunk = {
          response: {
            candidates: [
              {
                content: { parts: [], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.end();
      });
    } else {
      let body = '';
      apiRes.on('data', (chunk: Buffer) => (body += chunk));
      apiRes.on('end', () => {
        // Retry on 5xx with exponential backoff
        if (apiRes.statusCode! >= 500 && apiRes.statusCode! < 600 && retryCount < MAX_RETRIES) {
          const retryAfter = parseRetryAfter(apiRes.headers);
          const delay = retryAfter > 0 ? retryAfter : 1000 * Math.pow(2, retryCount);
          log.warn(
            `[Proxy] Server error ${apiRes.statusCode} for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
          );
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
          return;
        }

        // Retry on 429 with Retry-After header support + exponential backoff
        if (apiRes.statusCode === 429 && retryCount < MAX_RETRIES) {
          const retryAfter = parseRetryAfter(apiRes.headers);
          const delay = retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, retryCount);
          log.warn(
            `[Proxy] Rate limited (429) for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
          );
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
          return;
        }

        if (apiRes.statusCode! >= 400) {
          // P0-3: Only log status code and model name, NOT response body content
          log.error(`[Proxy] API error (${apiRes.statusCode}) for ${model.name}`);
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(body);
          return;
        }

        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;

          const reasoning =
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning_content ||
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning;
          if (reasoning) {
            modelReasoningContent.set(model.name, reasoning);
            touchStateTimestamp(stateTimestamps.reasoning, model.name);
          }

          const providerForResponse =
            model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
          const mapped = registry.translateResponse(providerForResponse, parsed, model.name);

          const cloudCodeResponse = {
            response: mapped,
            traceId: '',
            metadata: {},
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cloudCodeResponse));
        } catch (e) {
          log.error('[Proxy] Failed to map response:', e);

          if (retryCount < MAX_RETRIES) {
            log.warn(`[Proxy] Parse error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(
              () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
              1000 * (retryCount + 1),
            );
            return;
          }

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
        }
      });
    }
  });

  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    log.error(`[Proxy] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${model.name}`);
    request.destroy();

    if (retryCount < MAX_RETRIES) {
      log.warn(`[Proxy] Timeout for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s` } }));
    }
  });

  request.on('error', (err) => {
    log.error('[Proxy] Custom Model Request Error:', err);

    if (retryCount < MAX_RETRIES) {
      log.warn(`[Proxy] Network error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (isStream) {
      if (!res.headersSent) {
        const errResponse = {
          response: {
            candidates: [
              {
                content: { parts: [{ text: 'Network error: ' + err.message }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write('data: ' + JSON.stringify(errResponse) + '\n\n');
      }
      res.end();
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
      }
    }
  });

  request.write(JSON.stringify(payload));
  request.end();
}

// ─── Protobuf Utilities ────────────────────────────────────────────────────

interface ProtoField {
  tag: number;        // full tag (field_number << 3 | wire_type)
  wireType: number;
  fieldNum: number;
  value: number | Buffer | ProtoField[];
  start: number;
  end: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < buf.length) {
    const byte = buf[offset + bytes];
    result |= (byte & 0x7f) << shift;
    bytes++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, bytes };
}

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    parts.push(b);
  } while (v !== 0);
  return Buffer.from(parts);
}

function parseProto(buf: Buffer, offset: number, end: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const tagVarint = readVarint(buf, pos);
    const tag = tagVarint.value;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    pos += tagVarint.bytes;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
      pos += v.bytes;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos);
      pos += lenVarint.bytes;
      const len = lenVarint.value;
      const children = parseProto(buf, pos, pos + len);
      const hasChildren = children.length > 0;
      fields.push({ tag, wireType, fieldNum, value: hasChildren ? children : buf.subarray(pos, pos + len), start, end: pos + len });
      pos += len;
    } else if (wireType === 1) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeProtoBuf(fields: { tag: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const tagBuf = encodeVarint(field.tag);
    const data = field.value;
    const lenBuf = encodeVarint(data.length);
    parts.push(tagBuf, lenBuf, data);
  }
  return Buffer.concat(parts);
}

function findModelEntryFieldTag(fields: ProtoField[]): number | null {
  const tagCounts = new Map<number, number>();
  for (const f of fields) {
    if (f.wireType === 2) {
      tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
    }
  }
  let bestTag: number | null = null;
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }
  if (bestTag !== null && bestCount >= 2) {
    // Verify it has nested messages
    const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
    if (sample) return bestTag;
  }
  return bestTag;
}

function extractFieldMapping(entry: ProtoField[]): Map<number, 'string' | 'varint' | 'bytes'> {
  const mapping = new Map<number, 'string' | 'varint' | 'bytes'>();
  for (const f of entry) {
    if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      mapping.set(f.fieldNum, 'string');
    } else if (f.wireType === 0) {
      mapping.set(f.fieldNum, 'varint');
    } else if (f.wireType === 2 && Array.isArray(f.value)) {
      mapping.set(f.fieldNum, 'bytes');
    }
  }
  return mapping;
}

function encodeModelEntryForGetModels(
  name: string,
  displayName: string,
  mapping: Map<number, 'string' | 'varint' | 'bytes'>,
): Buffer {
  const fields: { tag: number; value: Buffer }[] = [];
  for (const [fieldNum, protoType] of mapping) {
    if (protoType === 'string') {
      const tag = (fieldNum << 3) | 2;
      if (fieldNum === 1) {
        fields.push({ tag, value: Buffer.from(name, 'utf-8') });
      } else if (fieldNum === 2) {
        fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
      } else {
        fields.push({ tag, value: Buffer.alloc(0) });
      }
    } else if (protoType === 'varint') {
      const tag = (fieldNum << 3) | 0;
      fields.push({ tag, value: encodeVarint(0) });
    } else {
      const tag = (fieldNum << 3) | 2;
      fields.push({ tag, value: Buffer.alloc(0) });
    }
  }
  return encodeProtoBuf(fields);
}

// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────

function handleGetAvailableModelsProxy(
  res: http.ServerResponse,
  reqBody: Buffer,
  lsUrl: string,
): void {
  const lsParsed = new URL(lsUrl);
  const client = lsParsed.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: lsParsed.hostname,
    port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
    path: lsParsed.pathname + lsParsed.search,
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'Accept': 'application/grpc-web+proto',
      'Content-Length': String(reqBody.length),
    },
    rejectUnauthorized: false,
  };

  const lsReq = client.request(options, (lsRes) => {
    const chunks: Buffer[] = [];
    lsRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    lsRes.on('end', () => {
      const responseBuf = Buffer.concat(chunks);
      const customModels = loadCustomModels();
      let modifiedBuf = responseBuf;

      if (customModels.length > 0 && responseBuf.length > 6) {
        try {
          const flags = responseBuf[0];
          const msgLen = responseBuf.readUInt32BE(1);
          if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed);

            if (modelTag !== null) {
              const sampleEntry = parsed.find(
                (f) => f.tag === modelTag && Array.isArray(f.value),
              );
              if (sampleEntry && Array.isArray(sampleEntry.value)) {
                const fieldMapping = extractFieldMapping(sampleEntry.value);
                const newParts: Buffer[] = [msgBody];

                for (const m of customModels) {
                  const placeholderId = generateModelPlaceholderId(m);
                  const entry = encodeModelEntryForGetModels(
                    'models/' + placeholderId,
                    m.displayName,
                    fieldMapping,
                  );
                  const tagBuf = encodeVarint(modelTag);
                  const lenBuf = encodeVarint(entry.length);
                  newParts.push(tagBuf, lenBuf, entry);
                  log.info(
                    `[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`,
                  );
                }

                const newMsgBody = Buffer.concat(newParts);
                const newHeader = Buffer.alloc(5);
                newHeader[0] = flags;
                newHeader.writeUInt32BE(newMsgBody.length, 1);
                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
              }
            }
          }
        } catch (err) {
          log.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
        }
      }

      res.writeHead(lsRes.statusCode || 200, {
        'Content-Type': 'application/grpc-web+proto',
        'Content-Length': String(modifiedBuf.length),
      });
      res.end(modifiedBuf);
    });

    lsRes.on('error', (err) => {
      log.error('[Proxy] LS error for GetAvailableModels:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });
  });

  lsReq.setTimeout(30_000, () => {
    log.error('[Proxy] GetAvailableModels forward timed out');
    lsReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end();
    }
  });

  lsReq.on('error', (err) => {
    log.error('[Proxy] GetAvailableModels forward error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  lsReq.write(reqBody);
  lsReq.end();
}

// ─── Main Request Handler ─────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.url = req.url!.replace(/^.*\/dummy_path_padding/, '');
  // Strip binary patch padding (from LS hostname replacement)
  req.url = req.url!.replace(/\/v1internal\/x{7}/, '');

  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        port: proxyPort,
        memory: {
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        state: {
          activeStreamContexts: activeStreamContexts.size,
          modelToolCallIds: modelToolCallIds.size,
          translatedToolCalls: translatedToolCalls.size,
          modelReasoningContent: modelReasoningContent.size,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
  let bodyLength = 0;
  let bodyRejected = false;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) {
        bodyRejected = true;
        log.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }),
          );
        }
      }
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on('end', () => {
    if (bodyRejected) return;

    const fullBody = Buffer.concat(bodyChunks);
    const bodyStr = fullBody.toString('utf-8');

    log.info(`[Proxy] Request: ${req.method} ${req.url}`);

    // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
    if (req.url!.startsWith('/GetAvailableModels')) {
      const gavParsed = new URL(req.url!, 'http://127.0.0.1');
      const lsUrl = gavParsed.searchParams.get('ls');
      if (lsUrl) {
        handleGetAvailableModelsProxy(res, fullBody, lsUrl);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ls parameter' }));
      return;
    }

    // 1. Intercept /v1internal:fetchAvailableModels
    if (req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels request');

      const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
      delete fwdHeaders['connection'];
      delete fwdHeaders['keep-alive'];
      delete fwdHeaders['accept-encoding'];

      const fwdOptions: https.RequestOptions = {
        method: req.method,
        headers: fwdHeaders as Record<string, string>,
      };

      const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
        // P0-5: Timeout for fetchAvailableModels forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] fetchAvailableModels forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: 1048576,
                maxOutputTokens: 4096,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            log.info(
              `[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`,
            );

            const googleJson = JSON.parse(googleBody) as Record<string, unknown>;
            const customModels = loadCustomModels();

            log.info(`[Proxy] Loaded custom models count: ${customModels.length}`);

            const mergeModels = (target: unknown): unknown => {
              if (Array.isArray(target)) {
                const mapped = customModels.map((m) => {
                  const cap = detectModelCapabilities(m, true);
                  return {
                    name: 'models/' + generateModelPlaceholderId(m),
                    version: '1.0',
                    displayName: m.displayName,
                    description: m.description,
                    inputTokenLimit: cap.maxTokens,
                    outputTokenLimit: cap.maxOutputTokens,
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                    temperature: cap.isThinking ? undefined : 0.7,
                    topP: cap.isThinking ? undefined : 0.9,
                    topK: cap.isThinking ? undefined : 40,
                  };
                });
                return [...mapped, ...target];
              } else if (target && typeof target === 'object') {
                const result = { ...(target as Record<string, unknown>) };
                customModels.forEach((m) => {
                  const slug = toSlug(m);
                  const cap = detectModelCapabilities(m, true);
                  const entry: Record<string, unknown> = {
                    displayName: m.displayName,
                    supportsImages: cap.supportsImages,
                    supportsThinking: cap.isThinking,
                    recommended: true,
                    maxTokens: cap.maxTokens,
                    maxOutputTokens: cap.maxOutputTokens,
                    tokenizerType: 'LLAMA_WITH_SPECIAL',
                    model: generateModelPlaceholderId(m),
                    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                    modelProvider: 'MODEL_PROVIDER_GOOGLE',
                  };
                  if (cap.supportsImages) {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'image/png': true,
                      'image/jpeg': true,
                      'image/webp': true,
                      'image/gif': true,
                      'image/heic': true,
                      'image/heif': true,
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  } else {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  }
                  (result as Record<string, unknown>)[slug] = entry;
                  m._slug = slug;
                  log.info(
                    `[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => thinking: ${cap.isThinking} => images: ${cap.supportsImages}`,
                  );
                });
                return result;
              }
              return target;
            };

            let merged = false;
            if (googleJson.models) {
              googleJson.models = mergeModels(googleJson.models);
              merged = true;
            }
            if (googleJson.availableModels) {
              googleJson.availableModels = mergeModels(googleJson.availableModels);
              merged = true;
            }
            if (googleJson.available_models) {
              googleJson.available_models = mergeModels(googleJson.available_models);
              merged = true;
            }

            if (!merged) {
              const modelsMap: Record<string, unknown> = {};
              customModels.forEach((m) => {
                const slug = toSlug(m);
                modelsMap[slug] = {
                  displayName: m.displayName,
                  recommended: true,
                  maxTokens: 1048576,
                  maxOutputTokens: 4096,
                  tokenizerType: 'LLAMA_WITH_SPECIAL',
                  model: generateModelPlaceholderId(m),
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                };
                m._slug = slug;
              });
              googleJson.models = modelsMap;
            }

            // Inject custom model slugs into agentModelSorts
            const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
            if (customSlugs.length > 0) {
              if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                (googleJson.agentModelSorts as { groups?: { modelIds?: string[] }[] }[]).forEach((sort) => {
                  if (sort.groups && Array.isArray(sort.groups)) {
                    sort.groups.forEach((group) => {
                      if (group.modelIds && Array.isArray(group.modelIds)) {
                        customSlugs.forEach((slug) => {
                          if (!group.modelIds!.includes(slug)) {
                            group.modelIds!.push(slug);
                          }
                        });
                      }
                    });
                  }
                });
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: 1048576,
                maxOutputTokens: 4096,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
        const customModels = loadCustomModels();
        const mappedCustom: Record<string, unknown> = {};
        customModels.forEach((m) => {
          const slug = toSlug(m);
          mappedCustom[slug] = {
            displayName: m.displayName,
            maxTokens: 1048576,
            maxOutputTokens: 4096,
            model: generateModelPlaceholderId(m),
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: mappedCustom }));
      });

      if (fullBody && fullBody.length > 0) {
        googleReq.write(fullBody);
      }
      googleReq.end();
      return;
    }

    // 2. Intercept /v1beta/models or /v1/models list request
    if (req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list request');

      const targetUrl = 'https://generativelanguage.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const mdlHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];
      delete mdlHeaders['accept-encoding'];

      const mdlOptions: https.RequestOptions = { method: 'GET', headers: mdlHeaders as Record<string, string> };

      const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
        // P0-5: Timeout for models list forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] Models list forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: customModels.map((m) => ({
                  name: m.name,
                  displayName: m.displayName,
                  description: m.description,
                  supportedGenerationMethods: ['generateContent'],
                })),
              }),
            );
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as { models?: unknown[] };
            const customModels = loadCustomModels();

            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
            }));

            if (googleJson.models) {
              googleJson.models = [...mappedCustom, ...googleJson.models];
            } else {
              googleJson.models = mappedCustom;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Google list models failed, returning custom models list only:', err);
            const customModels = loadCustomModels();
            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Google models list request error:', err);
        const customModels = loadCustomModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: customModels.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              description: m.description,
              supportedGenerationMethods: ['generateContent'],
            })),
          }),
        );
      });
      googleReq.end();
      return;
    }

    // 3. Intercept Cloud Code generation stream or non-stream requests
    const isCloudCodeStream =
      req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(bodyStr) as Record<string, unknown>;
        const modelName = reqJson.model as string | undefined;
        const modelId = (reqJson.modelId || reqJson.model_id) as string | undefined;
        log.info(
          `[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`,
        );
        if (modelName) {
          const customModels = loadCustomModels();
          const matchedCustomModel = customModels.find((m) => {
            const enumName = generateModelPlaceholderId(m);
            return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === modelId;
          });
          if (matchedCustomModel) {
            log.info(
              `[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`,
            );
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
            handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream);
            return;
          }
        }
      } catch (err) {
        log.error('[Proxy] Failed to parse Cloud Code stream body:', err);
      }
    }

    // 4. Intercept standard generateContent / streamGenerateContent request
    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

    const isGenerate = !!generateMatch;
    const isStandardStream = !!streamMatch;

    if (req.method === 'POST' && (isGenerate || isStandardStream)) {
      const matchedModelName = isGenerate ? generateMatch![1] : streamMatch![1];
      const customModels = loadCustomModels();
      const matchedCustomModel = customModels.find((m) => {
        const enumName = generateModelPlaceholderId(m);
        return (
          m.name === matchedModelName ||
          toSlug(m) === matchedModelName ||
          enumName === matchedModelName ||
          'models/' + enumName === matchedModelName
        );
      });

      if (matchedCustomModel) {
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream);
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      }
    }

    // 5. Fallback: transparent proxy to Google
    proxyToGoogle(req, res, fullBody);
  });
}

// ─── Server Start/Stop ────────────────────────────────────────────────────

export function startProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);

    // P1-9: Start managed cleanup interval
    startCleanupInterval();

    let primaryPort = 50999;

    function tryListen(port: number): void {
      server!.listen(port, '127.0.0.1', () => {
        proxyPort = (server!.address() as import('net').AddressInfo).port;
        log.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
        resolve(proxyPort);
      });
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && primaryPort === 50999) {
        log.warn('[Proxy] Port 50999 is already in use. Retrying on dynamic port...');
        primaryPort = 0;
        tryListen(0);
      } else {
        log.error('[Proxy] Startup failed:', err);
        reject(err);
      }
    });

    tryListen(primaryPort);
  });
}

export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    // P1-9: Stop cleanup interval to prevent orphaned timers
    stopCleanupInterval();

    if (server) {
      server.close(() => {
        log.info('[Proxy] Server stopped');
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export function getProxyPort(): number {
  return proxyPort;
}
