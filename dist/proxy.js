"use strict";
/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startProxy = startProxy;
exports.stopProxy = stopProxy;
exports.getProxyPort = getProxyPort;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const electron_1 = require("electron");
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Imports ──────────────────────────────────────────────────────────────
let server = null;
let proxyPort = 0;
// Shared cross-turn state
const shared_1 = require("./proxy/shared");
// Model configuration & capability detection
const modelUtils_1 = require("./proxy/modelUtils");
// Provider translator registry (auto-discovers translators from proxy/translators/)
const registry = __importStar(require("./proxy/registry"));
// Dynamic imports (stays require for Electron-specific modules)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoStore = require('./cryptoStore');
// ─── Model Helpers ────────────────────────────────────────────────────────
function generateModelPlaceholderId(model) {
    const input = (model.displayName || model.name || 'custom-model').toLowerCase();
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = (hash << 5) + hash + input.charCodeAt(i);
        hash = hash & hash; // Force 32-bit integer
    }
    const placeholderNum = 400 + (Math.abs(hash) % 200);
    return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}
function getCustomModelsPath() {
    const geminiDir = path.join(electron_1.app.getPath('home'), '.gemini', 'antigravity');
    return path.join(geminiDir, 'custom_models.json');
}
function toSlug(model) {
    return ('custom-' +
        (model.externalModelName || model.name)
            .replace(/^models\//, '')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase());
}
// ─── Model Loading ────────────────────────────────────────────────────────
function loadCustomModels() {
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
            defaultModels.models.forEach((m) => {
                m.encrypted = false;
            });
            const encrypted = cryptoStore.encryptModels(defaultModels.models);
            fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
        }
        catch (e) {
            electron_log_1.default.error('[Proxy] Failed to write default custom_models.json', e);
        }
        return cryptoStore.decryptModels(defaultModels.models);
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        const models = parsed.models || [];
        // Auto-migration check
        const needsMigration = models.some((m) => !m.encrypted &&
            m.apiKey &&
            m.apiKey !== 'none' &&
            !m.apiKey.startsWith('enc:') &&
            !m.apiKey.startsWith('fallback:'));
        if (needsMigration) {
            electron_log_1.default.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
            cryptoStore.backupFile(filePath);
            const encryptedModels = cryptoStore.encryptModels(models);
            try {
                fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), 'utf-8');
                electron_log_1.default.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
                return cryptoStore.decryptModels(encryptedModels);
            }
            catch (err) {
                electron_log_1.default.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
            }
        }
        const decrypted = cryptoStore.decryptModels(models);
        // Validate all models
        const validModels = [];
        for (let i = 0; i < decrypted.length; i++) {
            const validation = validateCustomModel(decrypted[i]);
            if (validation.valid) {
                validModels.push(decrypted[i]);
            }
            else {
                electron_log_1.default.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
            }
        }
        if (validModels.length < decrypted.length) {
            electron_log_1.default.info(`[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`);
        }
        return validModels;
    }
    catch (e) {
        electron_log_1.default.error('[Proxy] Failed to parse custom_models.json', e);
        return [];
    }
}
// ─── Google Proxy ─────────────────────────────────────────────────────────
function proxyToGoogle(req, res, reqBody) {
    const isCloudCodeUrl = req.url.includes('v1internal') || req.url.includes('daily-cloudcode');
    const targetUrl = isCloudCodeUrl
        ? 'https://daily-cloudcode-pa.googleapis.com'
        : 'https://generativelanguage.googleapis.com';
    const parsedUrl = new URL(req.url, targetUrl);
    const headers = {
        ...req.headers,
    };
    headers['host'] = isCloudCodeUrl ? 'daily-cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';
    delete headers['connection'];
    delete headers['keep-alive'];
    const isGeneration = req.url.includes('generateContent') || req.url.includes('streamGenerateContent');
    const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;
    if (shouldBufferAndModify) {
        delete headers['accept-encoding'];
    }
    const options = {
        method: req.method,
        headers: headers,
    };
    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
        // P0-5: Timeout for Google proxy requests (60s)
        proxyReq.setTimeout(60000, () => {
            electron_log_1.default.error('[Proxy] Google proxy request timed out after 60s');
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
            }
        });
        if (shouldBufferAndModify) {
            const responseChunks = [];
            proxyRes.on('data', (chunk) => responseChunks.push(chunk));
            proxyRes.on('end', () => {
                const fullResBody = Buffer.concat(responseChunks);
                let text;
                const encoding = proxyRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try {
                        const zlib = require('zlib');
                        text = zlib.gunzipSync(fullResBody).toString('utf-8');
                    }
                    catch (e) {
                        electron_log_1.default.error('[Proxy] gunzipSync failed:', e);
                        text = fullResBody.toString('utf-8');
                    }
                }
                else {
                    text = fullResBody.toString('utf-8');
                }
                electron_log_1.default.info(`[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`);
                // P0-3: Response body content is NOT logged to disk. Only metadata.
                const proxyHost = req.headers.host || 'localhost';
                text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);
                const modifiedHeaders = { ...proxyRes.headers };
                delete modifiedHeaders['content-encoding'];
                const modifiedBuffer = Buffer.from(text, 'utf-8');
                modifiedHeaders['content-length'] = String(modifiedBuffer.length);
                res.writeHead(proxyRes.statusCode || 200, modifiedHeaders);
                res.end(modifiedBuffer);
            });
        }
        else {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
        }
    });
    proxyReq.on('error', (err) => {
        electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
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
function parseRetryAfter(headers) {
    const val = headers['retry-after'];
    if (!val)
        return 0;
    const raw = Array.isArray(val) ? val[0] : val;
    if (!raw)
        return 0;
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
function handleCustomModelRequest(res, model, geminiBody, isStream, retryCount = 0) {
    // P3-18: Configurable max retries per model (default 3, min 0, max 5)
    const MAX_RETRIES = Math.min(Math.max(model.maxRetries ?? 3, 0), 5);
    const REQUEST_TIMEOUT_MS = model.timeout || 120000;
    const provider = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
    const payload = registry.translateRequest(provider, geminiBody, model.externalModelName);
    const headers = registry.getProviderHeaders(provider, model.apiKey);
    if (isStream && registry.supportsStreaming(provider)) {
        payload.stream = true;
    }
    let finalUrlStr = model.apiUrl;
    // P3-15: Google AI Studio uses dynamic URL construction for streaming vs non-streaming
    // P3-16: Ollama uses URL normalization for default port and endpoint
    if (provider === 'google' || provider === 'ollama') {
        const providerTranslator = registry.getTranslator(provider);
        finalUrlStr = registry.getProviderUrl(finalUrlStr, model.externalModelName, isStream, providerTranslator);
    }
    else if (provider === 'openai' || model.provider === 'custom' || model.provider === 'openrouter') {
        const urlLower = finalUrlStr.toLowerCase();
        if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
            if (finalUrlStr.endsWith('/v1')) {
                finalUrlStr += '/chat/completions';
            }
            else if (!finalUrlStr.endsWith('/')) {
                finalUrlStr += '/v1/chat/completions';
            }
            else {
                finalUrlStr += 'v1/chat/completions';
            }
        }
    }
    const url = new URL(finalUrlStr);
    const client = url.protocol === 'https:' ? https : http;
    const options = {
        method: 'POST',
        headers: headers,
    };
    // P0-2: SSL bypass ONLY when user explicitly opts in via allowUnauthorized.
    // Custom providers no longer bypass SSL automatically.
    if (model.allowUnauthorized) {
        electron_log_1.default.warn(`[Proxy] SSL verification DISABLED for ${model.name} (allowUnauthorized=true). Connection is vulnerable to MITM.`);
        options.rejectUnauthorized = false;
    }
    electron_log_1.default.info(`[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
    const request = client.request(url, options, (apiRes) => {
        apiRes.on('error', (err) => {
            electron_log_1.default.error(`[Proxy] Upstream stream error for ${model.name}:`, err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Upstream connection error: ' + err.message } }));
            }
            else {
                res.end();
            }
        });
        if (isStream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            let buffer = '';
            apiRes.on('data', (chunk) => {
                buffer += chunk.toString('utf-8');
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    if (trimmed.startsWith('data: ')) {
                        const dataStr = trimmed.substring(6).trim();
                        if (dataStr === '[DONE]')
                            continue;
                        try {
                            const parsed = JSON.parse(dataStr);
                            const mapped = registry.translateStreamChunk(provider, parsed, model.name);
                            if (mapped) {
                                const cloudCodeResponse = {
                                    response: mapped,
                                    traceId: '',
                                    metadata: {},
                                };
                                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
                            }
                        }
                        catch (err) {
                            // Partial/invalid JSON chunks are normal during streaming; debug-level only
                            electron_log_1.default.debug(`[Proxy] Stream chunk parse warning for ${model.name}:`, err.message);
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
                                    response: mapped,
                                    traceId: '',
                                    metadata: {},
                                };
                                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
                            }
                        }
                        catch (e) {
                            electron_log_1.default.debug(`[Proxy] Stream buffer drain parse warning for ${model.name}:`, e.message);
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
        }
        else {
            let body = '';
            apiRes.on('data', (chunk) => (body += chunk));
            apiRes.on('end', () => {
                // Retry on 5xx with exponential backoff
                if (apiRes.statusCode >= 500 && apiRes.statusCode < 600 && retryCount < MAX_RETRIES) {
                    const retryAfter = parseRetryAfter(apiRes.headers);
                    const delay = retryAfter > 0 ? retryAfter : 1000 * Math.pow(2, retryCount);
                    electron_log_1.default.warn(`[Proxy] Server error ${apiRes.statusCode} for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`);
                    setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
                    return;
                }
                // Retry on 429 with Retry-After header support + exponential backoff
                if (apiRes.statusCode === 429 && retryCount < MAX_RETRIES) {
                    const retryAfter = parseRetryAfter(apiRes.headers);
                    const delay = retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, retryCount);
                    electron_log_1.default.warn(`[Proxy] Rate limited (429) for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`);
                    setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
                    return;
                }
                if (apiRes.statusCode >= 400) {
                    // P0-3: Only log status code and model name, NOT response body content
                    electron_log_1.default.error(`[Proxy] API error (${apiRes.statusCode}) for ${model.name}`);
                    res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
                    res.end(body);
                    return;
                }
                try {
                    const parsed = JSON.parse(body);
                    const reasoning = parsed.choices?.[0]
                        ?.message?.reasoning_content ||
                        parsed.choices?.[0]
                            ?.message?.reasoning;
                    if (reasoning) {
                        shared_1.modelReasoningContent.set(model.name, reasoning);
                        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.reasoning, model.name);
                    }
                    const providerForResponse = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
                    const mapped = registry.translateResponse(providerForResponse, parsed, model.name);
                    const cloudCodeResponse = {
                        response: mapped,
                        traceId: '',
                        metadata: {},
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(cloudCodeResponse));
                }
                catch (e) {
                    electron_log_1.default.error('[Proxy] Failed to map response:', e);
                    if (retryCount < MAX_RETRIES) {
                        electron_log_1.default.warn(`[Proxy] Parse error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
                        setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
                        return;
                    }
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
                }
            });
        }
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        electron_log_1.default.error(`[Proxy] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${model.name}`);
        request.destroy();
        if (retryCount < MAX_RETRIES) {
            electron_log_1.default.warn(`[Proxy] Timeout for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
            return;
        }
        if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s` } }));
        }
    });
    request.on('error', (err) => {
        electron_log_1.default.error('[Proxy] Custom Model Request Error:', err);
        if (retryCount < MAX_RETRIES) {
            electron_log_1.default.warn(`[Proxy] Network error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
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
        }
        else {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
            }
        }
    });
    request.write(JSON.stringify(payload));
    request.end();
}
// ─── Main Request Handler ─────────────────────────────────────────────────
function handleRequest(req, res) {
    req.url = req.url.replace(/^.*\/dummy_path_padding/, '');
    // Health check
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        const memUsage = process.memoryUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            port: proxyPort,
            memory: {
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            },
            state: {
                activeStreamContexts: shared_1.activeStreamContexts.size,
                modelToolCallIds: shared_1.modelToolCallIds.size,
                translatedToolCalls: shared_1.translatedToolCalls.size,
                modelReasoningContent: shared_1.modelReasoningContent.size,
            },
            timestamp: new Date().toISOString(),
        }));
        return;
    }
    // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
    let bodyLength = 0;
    let bodyRejected = false;
    const bodyChunks = [];
    req.on('data', (chunk) => {
        bodyLength += chunk.length;
        if (bodyLength > MAX_BODY_SIZE) {
            if (!bodyRejected) {
                bodyRejected = true;
                electron_log_1.default.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
                req.destroy();
                if (!res.headersSent) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }));
                }
            }
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', () => {
        if (bodyRejected)
            return;
        const fullBody = Buffer.concat(bodyChunks);
        const bodyStr = fullBody.toString('utf-8');
        electron_log_1.default.info(`[Proxy] Request: ${req.method} ${req.url}`);
        // 1. Intercept /v1internal:fetchAvailableModels
        if (req.url.includes('/v1internal:fetchAvailableModels')) {
            electron_log_1.default.info('[Proxy] Intercepting fetchAvailableModels request');
            const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const fwdHeaders = {
                ...req.headers,
            };
            fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
            delete fwdHeaders['connection'];
            delete fwdHeaders['keep-alive'];
            delete fwdHeaders['accept-encoding'];
            const fwdOptions = {
                method: req.method,
                headers: fwdHeaders,
            };
            const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
                // P0-5: Timeout for fetchAvailableModels forward request (30s)
                googleReq.setTimeout(30000, () => {
                    electron_log_1.default.error('[Proxy] fetchAvailableModels forward request timed out');
                    googleReq.destroy();
                    if (!res.headersSent) {
                        const customModels = loadCustomModels();
                        const mappedCustom = {};
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
                        electron_log_1.default.info(`[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`);
                        const googleJson = JSON.parse(googleBody);
                        const customModels = loadCustomModels();
                        electron_log_1.default.info(`[Proxy] Loaded custom models count: ${customModels.length}`);
                        const mergeModels = (target) => {
                            if (Array.isArray(target)) {
                                const mapped = customModels.map((m) => {
                                    const cap = (0, modelUtils_1.detectModelCapabilities)(m, true);
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
                            }
                            else if (target && typeof target === 'object') {
                                const result = { ...target };
                                customModels.forEach((m) => {
                                    const slug = toSlug(m);
                                    const cap = (0, modelUtils_1.detectModelCapabilities)(m, true);
                                    result[slug] = {
                                        displayName: m.displayName,
                                        supportsImages: false,
                                        supportsThinking: cap.isThinking,
                                        recommended: true,
                                        maxTokens: cap.maxTokens,
                                        maxOutputTokens: cap.maxOutputTokens,
                                        tokenizerType: 'LLAMA_WITH_SPECIAL',
                                        model: generateModelPlaceholderId(m),
                                        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                                        modelProvider: 'MODEL_PROVIDER_GOOGLE',
                                    };
                                    m._slug = slug;
                                    electron_log_1.default.info(`[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => supportsThinking: ${cap.isThinking}`);
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
                            const modelsMap = {};
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
                        const customSlugs = customModels.map((m) => m._slug).filter(Boolean);
                        if (customSlugs.length > 0) {
                            if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                                googleJson.agentModelSorts.forEach((sort) => {
                                    if (sort.groups && Array.isArray(sort.groups)) {
                                        sort.groups.forEach((group) => {
                                            if (group.modelIds && Array.isArray(group.modelIds)) {
                                                customSlugs.forEach((slug) => {
                                                    if (!group.modelIds.includes(slug)) {
                                                        group.modelIds.push(slug);
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
                    }
                    catch (err) {
                        electron_log_1.default.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
                        const customModels = loadCustomModels();
                        const mappedCustom = {};
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
                electron_log_1.default.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
                const customModels = loadCustomModels();
                const mappedCustom = {};
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
        if (req.method === 'GET' && (req.url.endsWith('/models') || req.url.includes('/models?'))) {
            electron_log_1.default.info('[Proxy] Intercepting models list request');
            const targetUrl = 'https://generativelanguage.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const mdlHeaders = {
                ...req.headers,
            };
            mdlHeaders['host'] = 'generativelanguage.googleapis.com';
            delete mdlHeaders['connection'];
            delete mdlHeaders['accept-encoding'];
            const mdlOptions = { method: 'GET', headers: mdlHeaders };
            const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
                // P0-5: Timeout for models list forward request (30s)
                googleReq.setTimeout(30000, () => {
                    electron_log_1.default.error('[Proxy] Models list forward request timed out');
                    googleReq.destroy();
                    if (!res.headersSent) {
                        const customModels = loadCustomModels();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            models: customModels.map((m) => ({
                                name: m.name,
                                displayName: m.displayName,
                                description: m.description,
                                supportedGenerationMethods: ['generateContent'],
                            })),
                        }));
                    }
                });
                let googleBody = '';
                googleRes.on('data', (chunk) => (googleBody += chunk));
                googleRes.on('end', () => {
                    try {
                        const googleJson = JSON.parse(googleBody);
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
                        }
                        else {
                            googleJson.models = mappedCustom;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(googleJson));
                    }
                    catch (err) {
                        electron_log_1.default.error('[Proxy] Google list models failed, returning custom models list only:', err);
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
                electron_log_1.default.error('[Proxy] Google models list request error:', err);
                const customModels = loadCustomModels();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    models: customModels.map((m) => ({
                        name: m.name,
                        displayName: m.displayName,
                        description: m.description,
                        supportedGenerationMethods: ['generateContent'],
                    })),
                }));
            });
            googleReq.end();
            return;
        }
        // 3. Intercept Cloud Code generation stream or non-stream requests
        const isCloudCodeStream = req.url.includes('/v1internal:streamGenerateContent') || req.url.includes('/v1internal:generateContent');
        if (req.method === 'POST' && isCloudCodeStream) {
            try {
                const reqJson = JSON.parse(bodyStr);
                const modelName = reqJson.model;
                const modelId = (reqJson.modelId || reqJson.model_id);
                electron_log_1.default.info(`[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`);
                if (modelName) {
                    const customModels = loadCustomModels();
                    const matchedCustomModel = customModels.find((m) => {
                        const enumName = generateModelPlaceholderId(m);
                        return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === modelId;
                    });
                    if (matchedCustomModel) {
                        electron_log_1.default.info(`[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`);
                        const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
                        const actualGeminiBody = (reqJson.request || reqJson);
                        handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream);
                        return;
                    }
                }
            }
            catch (err) {
                electron_log_1.default.error('[Proxy] Failed to parse Cloud Code stream body:', err);
            }
        }
        // 4. Intercept standard generateContent / streamGenerateContent request
        const generateMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
        const streamMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);
        const isGenerate = !!generateMatch;
        const isStandardStream = !!streamMatch;
        if (req.method === 'POST' && (isGenerate || isStandardStream)) {
            const matchedModelName = isGenerate ? generateMatch[1] : streamMatch[1];
            const customModels = loadCustomModels();
            const matchedCustomModel = customModels.find((m) => {
                const enumName = generateModelPlaceholderId(m);
                return (m.name === matchedModelName ||
                    toSlug(m) === matchedModelName ||
                    enumName === matchedModelName ||
                    'models/' + enumName === matchedModelName);
            });
            if (matchedCustomModel) {
                try {
                    const geminiBody = JSON.parse(bodyStr);
                    handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream);
                    return;
                }
                catch (e) {
                    electron_log_1.default.error('[Proxy] JSON parse error in request body:', e);
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
function startProxy() {
    return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        // P1-9: Start managed cleanup interval
        (0, shared_1.startCleanupInterval)();
        let primaryPort = 50999;
        function tryListen(port) {
            server.listen(port, '127.0.0.1', () => {
                proxyPort = server.address().port;
                electron_log_1.default.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
                resolve(proxyPort);
            });
        }
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && primaryPort === 50999) {
                electron_log_1.default.warn('[Proxy] Port 50999 is already in use. Retrying on dynamic port...');
                primaryPort = 0;
                tryListen(0);
            }
            else {
                electron_log_1.default.error('[Proxy] Startup failed:', err);
                reject(err);
            }
        });
        tryListen(primaryPort);
    });
}
function stopProxy() {
    return new Promise((resolve) => {
        // P1-9: Stop cleanup interval to prevent orphaned timers
        (0, shared_1.stopCleanupInterval)();
        if (server) {
            server.close(() => {
                electron_log_1.default.info('[Proxy] Server stopped');
                server = null;
                resolve();
            });
        }
        else {
            resolve();
        }
    });
}
function getProxyPort() {
    return proxyPort;
}
//# sourceMappingURL=proxy.js.map