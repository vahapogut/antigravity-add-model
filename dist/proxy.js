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
exports.setLanguageServerPortResolver = setLanguageServerPortResolver;
exports.loadCustomModels = loadCustomModels;
exports.startProxy = startProxy;
exports.stopProxy = stopProxy;
exports.getProxyPort = getProxyPort;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Imports ──────────────────────────────────────────────────────────────
let server = null;
let proxyPort = 0;
let startingProxy = null;
let stoppingProxy = null;
let serviceDataDirectory;
const DEFAULT_SHUTDOWN_GRACE_MS = 1500;
let shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS;
let cloudCodeRouting;
const upstreamRequests = new Set();
function trackUpstream(request) {
    upstreamRequests.add(request);
    request.once('close', () => upstreamRequests.delete(request));
    if (stoppingProxy)
        request.destroy();
}
function stopUpstreams() {
    for (const request of upstreamRequests)
        request.destroy();
}
function rejectDuringShutdown(res) {
    if (!stoppingProxy)
        return false;
    if (!res.destroyed && !res.writableEnded) {
        res.writeHead(503, { Connection: 'close', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy is shutting down' }));
    }
    return true;
}
// Shared cross-turn state
const shared_1 = require("./proxy/shared");
// Model configuration & capability detection
const modelUtils_1 = require("./proxy/modelUtils");
const cloudCodeRouting_1 = require("./proxy/cloudCodeRouting");
const modelCatalog_1 = require("./proxy/modelCatalog");
const modelIdentity_1 = require("./modelIdentity");
// Custom request transport and model storage
const customRequest_1 = require("./proxy/customRequest");
const modelStore_1 = require("./modelStore");
const listen_1 = require("./proxy/listen");
const subagentRouting_1 = require("./proxy/subagentRouting");
const subagentModels_1 = require("./proxy/subagentModels");
const loopbackSecurity_1 = require("./proxy/loopbackSecurity");
const nativeSubagentResponse_1 = require("./proxy/nativeSubagentResponse");
const googlePoolFailover_1 = require("./proxy/googlePoolFailover");
let languageServerPortResolver;
let languageServerRoutingEnabled = false;
/** Registered by the desktop with its own live language-server port getter. */
function setLanguageServerPortResolver(resolve) {
    languageServerPortResolver = resolve;
}
function currentLanguageServerPort() {
    if (!languageServerRoutingEnabled)
        return undefined;
    try {
        return languageServerPortResolver?.();
    }
    catch {
        return undefined;
    }
}
// Dynamic imports (stays require for Electron-specific modules)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoStore = require('./cryptoStore');
// ─── Model Helpers ────────────────────────────────────────────────────────
function getCustomModelsPath() {
    const geminiDir = serviceDataDirectory || path.join(require('electron').app.getPath('home'), '.gemini', 'antigravity');
    return path.join(geminiDir, 'custom_models.json');
}
function modelIdentities(models, upstream) {
    try {
        // Include disabled entries so toggling an effort variant cannot reassign another model's identity.
        const saved = (0, modelStore_1.readModelConfig)(getCustomModelsPath()).filter((model) => typeof model.name === 'string' && model.name);
        const configured = [...new Map([...saved, ...models].map((model) => [model.name, model])).values()];
        return new Map((0, modelIdentity_1.allocateModelIdentities)(path.dirname(getCustomModelsPath()), configured, upstream).map((identity) => [
            identity.name,
            identity,
        ]));
    }
    catch (error) {
        electron_log_1.default.error('[Proxy] Native model identities unavailable; custom models remain accessible by their direct aliases:', error);
        return new Map(models.map((model) => [model.name, { name: model.name, catalogId: (0, modelCatalog_1.catalogModelSlug)(model, models) }]));
    }
}
function matchCustomModel(models, ...selectors) {
    const identities = modelIdentities(models);
    // Named aliases remain available even when the finite native enum pool is exhausted.
    for (const selector of selectors) {
        if (typeof selector !== 'string')
            continue;
        const exact = models.find((model) => model.name === selector);
        if (exact)
            return exact;
        const named = models.find((model) => identities.get(model.name)?.catalogId === selector.replace(/^models\//, '') ||
            (0, modelCatalog_1.localModelSlug)(model) === selector.replace(/^models\//, ''));
        if (named)
            return named;
    }
    return models.find((model) => {
        const identity = identities.get(model.name);
        return (identity?.placeholderId &&
            selectors.some((selector) => selector === identity.placeholderId ||
                selector === `models/${identity.placeholderId}` ||
                selector === identity.placeholderValue));
    });
}
function customCloudCodeCatalog(upstream = {}) {
    const models = loadCustomModels();
    const identities = modelIdentities(models, upstream);
    const labels = (0, modelCatalog_1.catalogDisplayNames)(models, upstream);
    return (0, modelCatalog_1.mergeCloudCodeCatalog)(upstream, models
        .filter((model) => identities.get(model.name)?.placeholderId)
        .map((model) => {
        const identity = identities.get(model.name);
        const slug = identity.catalogId;
        const cap = (0, modelUtils_1.detectModelCapabilities)(model);
        const nativeCap = (0, modelUtils_1.nativeCatalogCapabilities)(model);
        const modelExperiments = (0, modelUtils_1.nativeModelExperiments)(model);
        const capabilities = getAdvertisedModelCapabilities(model);
        return {
            slug,
            mapEntry: {
                displayName: labels.get(model.name),
                ...capabilities,
                recommended: true,
                maxTokens: nativeCap.maxTokens,
                maxOutputTokens: cap.maxOutputTokens,
                tokenizerType: 'LLAMA_WITH_SPECIAL',
                model: identity.placeholderId,
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
                // IDE 2.5.5 otherwise summarizes custom chats with its built-in M50.
                // Use its per-model checkpoint configuration so the selected custom
                // model receives the native summary request and its effort override.
                ...(modelExperiments ? { modelExperiments } : {}),
            },
            listEntry: {
                name: 'models/' + slug,
                version: '1.0',
                displayName: labels.get(model.name),
                description: model.description,
                ...capabilities,
                inputTokenLimit: cap.maxTokens,
                outputTokenLimit: cap.maxOutputTokens,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
        };
    }));
}
function getAdvertisedModelCapabilities(model) {
    const cap = (0, modelUtils_1.detectModelCapabilities)(model);
    const nativeGoogle = !model.gateway &&
        (model.apiFormat === 'google' || (!model.apiFormat && ['google', 'google-cloudcode'].includes(model.provider)));
    return {
        supportsImages: cap.supportsImages,
        supportsThinking: cap.isThinking,
        supportsVideo: false,
        supportedMimeTypes: {
            ...(cap.supportsImages
                ? {
                    'image/png': true,
                    'image/jpeg': true,
                    'image/webp': true,
                    'image/gif': true,
                    ...(nativeGoogle ? { 'image/heic': true, 'image/heif': true } : {}),
                }
                : {}),
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
        },
    };
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
        const models = (0, modelStore_1.readModelConfig)(filePath);
        // Auto-migration check
        const unprotected = (value) => typeof value === 'string' && value && value !== 'none' && !/^(enc:|fallback:|local-gcm:)/.test(value);
        const needsMigration = models.some((m) => (!m.encrypted && unprotected(m.apiKey)) ||
            (!m.encryptedHeaders && Object.values(m.customHeaders || {}).some(unprotected)) ||
            (!m.encryptedGoogleAccounts &&
                (m.googleAccounts || []).some((account) => [account.accessToken, account.refreshToken, account.clientSecret].some(unprotected))));
        if (needsMigration) {
            electron_log_1.default.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
            cryptoStore.backupFile(filePath);
            const encryptedModels = cryptoStore.encryptModels(models);
            for (const model of encryptedModels) {
                if (model.customHeaders && !model.encryptedHeaders) {
                    model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([name, value]) => [
                        name,
                        unprotected(value) ? cryptoStore.encryptString(value) : value,
                    ]));
                    model.encryptedHeaders = true;
                }
                if (model.googleAccounts && !model.encryptedGoogleAccounts) {
                    model.googleAccounts = model.googleAccounts.map((account) => {
                        const encrypted = { ...account };
                        for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                            if (unprotected(encrypted[field]))
                                encrypted[field] = cryptoStore.encryptString(encrypted[field]);
                        return encrypted;
                    });
                    model.encryptedGoogleAccounts = true;
                }
            }
            try {
                (0, modelStore_1.writeJsonAtomic)(filePath, { models: encryptedModels });
                electron_log_1.default.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
                // Continue through validation and enabled filtering below.
            }
            catch (err) {
                electron_log_1.default.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
            }
        }
        const decrypted = cryptoStore.decryptModels(models);
        for (const model of decrypted) {
            if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(model.apiKey || '')) {
                model.enabled = false;
                electron_log_1.default.warn('[Proxy] Skipping a model whose API key could not be decrypted');
                continue;
            }
            if (model.googleAccounts) {
                model.googleAccounts = model.googleAccounts.flatMap((account) => {
                    const decryptedAccount = { ...account };
                    for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
                        const value = decryptedAccount[field];
                        if (!value)
                            continue;
                        if (model.encryptedGoogleAccounts)
                            decryptedAccount[field] = cryptoStore.decryptString(value);
                        if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedAccount[field] || '')) {
                            electron_log_1.default.warn('[Proxy] Skipping a Google account whose credentials could not be decrypted');
                            return [];
                        }
                    }
                    return [decryptedAccount];
                });
                model.encryptedGoogleAccounts = false;
            }
            if (model.encryptedHeaders && model.customHeaders) {
                model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([key, value]) => {
                    const decryptedHeader = cryptoStore.decryptString(value);
                    if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedHeader || '')) {
                        model.enabled = false;
                        electron_log_1.default.warn('[Proxy] Skipping a model whose custom header could not be decrypted');
                    }
                    return [key, decryptedHeader];
                }));
                model.encryptedHeaders = false;
            }
        }
        // Validate all models
        const validModels = [];
        for (let i = 0; i < decrypted.length; i++) {
            const validation = validateCustomModel(decrypted[i]);
            if (validation.valid) {
                if (decrypted[i].enabled !== false)
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
function forwardingHeaders(source) {
    const headers = { ...source };
    const nominated = String(headers.connection || '')
        .split(',')
        .map((name) => name.trim().toLowerCase());
    for (const name of [
        ...nominated,
        'connection',
        'keep-alive',
        'transfer-encoding',
        'te',
        'trailer',
        'upgrade',
        'proxy-authenticate',
        'proxy-authorization',
    ]) {
        delete headers[name];
    }
    return headers;
}
function hasSubagentTool(body) {
    return (body.tools?.some((group) => {
        const declarations = group?.functionDeclarations;
        return Array.isArray(declarations) && declarations.some((tool) => tool?.name === 'invoke_subagent');
    }) ||
        body.contents?.some((content) => content.parts?.some((part) => part.functionCall?.name === 'invoke_subagent')) ||
        false);
}
function proxyToGoogle(req, res, reqBody, nativeSubagent) {
    const generation = req.url.includes('generateContent') || req.url.includes('streamGenerateContent');
    const cloudCode = req.url.includes('v1internal') || req.url.includes('daily-cloudcode');
    if (!cloudCodeRouting || !cloudCode || !generation) {
        forwardToGoogle(req, res, reqBody, nativeSubagent);
        return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    void cloudCodeRouting
        .resolveForGeneration(req.headers, reqBody, controller.signal)
        .then((origin) => {
        if (!res.destroyed && !res.writableEnded)
            forwardToGoogle(req, res, reqBody, nativeSubagent, origin);
    })
        .catch(() => {
        if (res.destroyed || res.writableEnded)
            return;
        electron_log_1.default.warn('[Proxy] Could not determine the native Cloud Code account route.');
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Could not determine the native Cloud Code account route. Please retry.' },
        }));
    })
        .finally(() => res.off('close', cancel));
}
function forwardToGoogle(req, res, reqBody, nativeSubagent, cloudCodeOrigin) {
    const isCloudCodeUrl = req.url.includes('v1internal') || req.url.includes('daily-cloudcode');
    const targetUrl = isCloudCodeUrl
        ? cloudCodeOrigin || cloudCodeRouting?.resolve(req.headers) || 'https://daily-cloudcode-pa.googleapis.com'
        : 'https://generativelanguage.googleapis.com';
    const parsedUrl = new URL(req.url, targetUrl);
    const headers = forwardingHeaders(req.headers);
    headers['host'] = parsedUrl.host;
    // Incoming request bodies have already been buffered and decoded by Node.
    // Never replay their chunked wire framing together with a content length.
    headers['content-length'] = String(reqBody.length);
    const isGeneration = req.url.includes('generateContent') || req.url.includes('streamGenerateContent');
    const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;
    if (shouldBufferAndModify) {
        delete headers['accept-encoding'];
    }
    if (nativeSubagent)
        headers['accept-encoding'] = 'identity';
    const options = {
        method: req.method,
        headers: headers,
    };
    let nativeResponse;
    const failForwarding = (status, message) => {
        if (stoppingProxy || res.destroyed || res.writableEnded || res.socket?.destroyed)
            return;
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
    };
    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
        const isRateLimit = isGeneration &&
            isCloudCodeUrl &&
            (proxyRes.statusCode === 429 || proxyRes.statusCode === 403);
        if (isRateLimit) {
            const errorChunks = [];
            let totalLen = 0;
            proxyRes.on('data', (chunk) => {
                if (totalLen < 16384) {
                    errorChunks.push(chunk);
                    totalLen += chunk.length;
                }
            });
            proxyRes.on('end', async () => {
                const errorBody = Buffer.concat(errorChunks).toString('utf8');
                const handled = await (0, googlePoolFailover_1.attemptGooglePoolFailover)(req, res, reqBody, proxyRes, errorBody, {
                    loadCustomModels,
                    forwardingHeaders,
                    cloudCodeRouting,
                    log: electron_log_1.default,
                }, nativeSubagent, cloudCodeOrigin);
                if (!handled) {
                    if (res.destroyed || res.writableEnded)
                        return;
                    res.writeHead(proxyRes.statusCode || 429, forwardingHeaders(proxyRes.headers));
                    res.end(Buffer.concat(errorChunks));
                }
            });
            return;
        }
        if (nativeSubagent && isGeneration) {
            nativeResponse = proxyRes;
            const streamHint = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
            void (0, nativeSubagentResponse_1.forwardNativeGeneration)(proxyRes, res, nativeSubagent, streamHint).catch((error) => {
                electron_log_1.default.error('[Proxy] Native generation forwarding failed:', error);
                failForwarding(502, 'Native generation forwarding failed.');
            });
            return;
        }
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
                if (cloudCodeRouting && parsedUrl.pathname === '/v1internal:loadCodeAssist') {
                    try {
                        cloudCodeRouting.observe(req.headers, proxyRes.statusCode || 500, JSON.parse(text));
                    }
                    catch {
                        /* Invalid responses must not change the account's upstream routing. */
                    }
                }
                const proxyHost = req.headers.host || 'localhost';
                text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);
                const modifiedHeaders = forwardingHeaders(proxyRes.headers);
                delete modifiedHeaders['content-encoding'];
                const modifiedBuffer = Buffer.from(text, 'utf-8');
                modifiedHeaders['content-length'] = String(modifiedBuffer.length);
                res.writeHead(proxyRes.statusCode || 200, modifiedHeaders);
                res.end(modifiedBuffer);
            });
        }
        else {
            res.writeHead(proxyRes.statusCode || 200, forwardingHeaders(proxyRes.headers));
            proxyRes.pipe(res);
        }
    });
    proxyReq.on('error', (err) => {
        electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
        if (nativeResponse) {
            nativeResponse.destroy(err);
            return;
        }
        failForwarding(502, 'Proxy forwarding failed: ' + err.message);
    });
    proxyReq.setTimeout(60000, () => {
        electron_log_1.default.error('[Proxy] Google proxy request timed out after 60s');
        if (nativeResponse)
            nativeResponse.destroy(new Error('Google API request timed out'));
        else
            failForwarding(504, 'Google API request timed out');
        proxyReq.destroy();
    });
    res.once('close', () => {
        if (!res.writableFinished)
            proxyReq.destroy();
    });
    trackUpstream(proxyReq);
    if (reqBody) {
        proxyReq.write(reqBody);
    }
    proxyReq.end();
}
// ─── File Data Resolver ────────────────────────────────────────────────────
async function resolveFileData(body, reqHeaders, downstream) {
    const contents = body.contents;
    if (!contents)
        return;
    const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '');
    for (const item of contents) {
        if (!item.parts)
            continue;
        for (let i = 0; i < item.parts.length; i++) {
            if (stoppingProxy || downstream.destroyed || downstream.writableEnded)
                return;
            const p = item.parts[i];
            const fd = p.fileData;
            if (!fd?.fileUri)
                continue;
            // Keep image bytes/URLs intact for the wire-format translator. In particular,
            // never decode a binary image as UTF-8 or send incoming Google credentials
            // to an arbitrary image URL. Remote images must be accessible to the provider.
            if ((typeof fd.mimeType === 'string' && /^image\//i.test(fd.mimeType.trim())) ||
                /^data:image\//i.test(fd.fileUri))
                continue;
            try {
                const uri = fd.fileUri;
                let fileContent = '';
                if (uri.startsWith('file://')) {
                    const fp = uri.replace('file://', '').replace(/\//g, path.sep);
                    if (fs.existsSync(fp))
                        fileContent = fs.readFileSync(fp, 'utf-8');
                }
                else if (authHeader && (0, loopbackSecurity_1.authenticatedGoogleFileUrl)(uri)) {
                    fileContent = await downloadFileContent(uri, authHeader);
                }
                if (fileContent) {
                    item.parts[i] = { text: '[File content]:\n\n' + fileContent };
                }
            }
            catch (e) {
                electron_log_1.default.warn('[Proxy] File resolve failed:', e.message);
            }
        }
    }
}
function downloadFileContent(url, authHeader) {
    return new Promise((resolve, reject) => {
        const u = (0, loopbackSecurity_1.authenticatedGoogleFileUrl)(url);
        if (!u) {
            reject(new Error('Authenticated file downloads require a Google API HTTPS URL'));
            return;
        }
        const request = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { Authorization: authHeader },
            timeout: 30000,
        }, (res) => {
            res.on('error', reject);
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            let d = '';
            res.on('data', (c) => (d += c.toString()));
            res.on('end', () => resolve(d));
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('File download timed out')));
        trackUpstream(request);
        request.end();
    });
}
// ─── Custom Model Request Handler ─────────────────────────────────────────
function handleCustomModelRequest(res, model, body, isStream, cloudEnvelope = true) {
    if (res.destroyed || res.writableEnded || rejectDuringShutdown(res))
        return;
    void (0, customRequest_1.runCustomModelRequest)(res, model, body, isStream, loadCustomModels(), cloudEnvelope);
}
function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let bytes = 0;
    while (offset + bytes < buf.length) {
        const byte = buf[offset + bytes];
        result |= (byte & 0x7f) << shift;
        bytes++;
        if (!(byte & 0x80))
            break;
        shift += 7;
    }
    return { value: result >>> 0, bytes };
}
function encodeVarint(value) {
    const parts = [];
    let v = value >>> 0;
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0)
            b |= 0x80;
        parts.push(b);
    } while (v !== 0);
    return Buffer.from(parts);
}
function parseProto(buf, offset, end) {
    const fields = [];
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
        }
        else if (wireType === 2) {
            const lenVarint = readVarint(buf, pos);
            pos += lenVarint.bytes;
            const len = lenVarint.value;
            const children = parseProto(buf, pos, pos + len);
            const hasChildren = children.length > 0;
            fields.push({
                tag,
                wireType,
                fieldNum,
                value: hasChildren ? children : buf.subarray(pos, pos + len),
                start,
                end: pos + len,
            });
            pos += len;
        }
        else if (wireType === 1) {
            fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
            pos += 8;
        }
        else if (wireType === 5) {
            fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
            pos += 4;
        }
        else {
            break;
        }
    }
    return fields;
}
function encodeProtoBuf(fields) {
    const parts = [];
    for (const field of fields) {
        const tagBuf = encodeVarint(field.tag);
        const data = field.value;
        const lenBuf = encodeVarint(data.length);
        parts.push(tagBuf, lenBuf, data);
    }
    return Buffer.concat(parts);
}
function findModelEntryFieldTag(fields) {
    const tagCounts = new Map();
    for (const f of fields) {
        if (f.wireType === 2) {
            tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
        }
    }
    let bestTag = null;
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
        if (sample)
            return bestTag;
    }
    return bestTag;
}
function extractFieldMapping(entry) {
    const mapping = new Map();
    for (const f of entry) {
        if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
            mapping.set(f.fieldNum, 'string');
        }
        else if (f.wireType === 0) {
            mapping.set(f.fieldNum, 'varint');
        }
        else if (f.wireType === 2 && Array.isArray(f.value)) {
            mapping.set(f.fieldNum, 'bytes');
        }
    }
    return mapping;
}
function encodeModelEntryForGetModels(name, displayName, mapping) {
    const fields = [];
    for (const [fieldNum, protoType] of mapping) {
        if (protoType === 'string') {
            const tag = (fieldNum << 3) | 2;
            if (fieldNum === 1) {
                fields.push({ tag, value: Buffer.from(name, 'utf-8') });
            }
            else if (fieldNum === 2) {
                fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
            }
            else {
                fields.push({ tag, value: Buffer.alloc(0) });
            }
        }
        else if (protoType === 'varint') {
            const tag = (fieldNum << 3) | 0;
            fields.push({ tag, value: encodeVarint(0) });
        }
        else {
            const tag = (fieldNum << 3) | 2;
            fields.push({ tag, value: Buffer.alloc(0) });
        }
    }
    return encodeProtoBuf(fields);
}
// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────
function handleGetAvailableModelsProxy(res, reqBody, lsUrl) {
    const lsParsed = (0, loopbackSecurity_1.languageServerModelsUrl)(lsUrl, currentLanguageServerPort());
    if (!lsParsed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'URL must target the active local language server model-list endpoint' } }));
        return;
    }
    const client = lsParsed.protocol === 'https:' ? https : http;
    const options = {
        method: 'POST',
        hostname: lsParsed.hostname,
        port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
        path: lsParsed.pathname + lsParsed.search,
        headers: {
            'Content-Type': 'application/grpc-web+proto',
            Accept: 'application/grpc-web+proto',
            'Content-Length': String(reqBody.length),
        },
        // The app's own loopback language server uses a self-signed certificate.
        // This exception is reachable only after matching its trusted port and RPC path.
        rejectUnauthorized: false,
    };
    const lsReq = client.request(options, (lsRes) => {
        const chunks = [];
        lsRes.on('data', (chunk) => chunks.push(chunk));
        lsRes.on('end', () => {
            const responseBuf = Buffer.concat(chunks);
            const customModels = loadCustomModels();
            const identities = modelIdentities(customModels);
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
                            const sampleEntry = parsed.find((f) => f.tag === modelTag && Array.isArray(f.value));
                            if (sampleEntry && Array.isArray(sampleEntry.value)) {
                                const fieldMapping = extractFieldMapping(sampleEntry.value);
                                const newParts = [msgBody];
                                for (const m of customModels) {
                                    const placeholderId = identities.get(m.name)?.placeholderId;
                                    if (!placeholderId)
                                        continue;
                                    const entry = encodeModelEntryForGetModels('models/' + placeholderId, m.displayName, fieldMapping);
                                    const tagBuf = encodeVarint(modelTag);
                                    const lenBuf = encodeVarint(entry.length);
                                    newParts.push(tagBuf, lenBuf, entry);
                                    electron_log_1.default.info(`[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`);
                                }
                                const newMsgBody = Buffer.concat(newParts);
                                const newHeader = Buffer.alloc(5);
                                newHeader[0] = flags;
                                newHeader.writeUInt32BE(newMsgBody.length, 1);
                                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
                            }
                        }
                    }
                }
                catch (err) {
                    electron_log_1.default.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
                }
            }
            res.writeHead(lsRes.statusCode || 200, {
                'Content-Type': 'application/grpc-web+proto',
                'Content-Length': String(modifiedBuf.length),
            });
            res.end(modifiedBuf);
        });
        lsRes.on('error', (err) => {
            if (stoppingProxy || res.destroyed || res.socket?.destroyed)
                return;
            electron_log_1.default.error('[Proxy] LS error for GetAvailableModels:', err.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end();
            }
        });
    });
    lsReq.setTimeout(30000, () => {
        electron_log_1.default.error('[Proxy] GetAvailableModels forward timed out');
        lsReq.destroy();
        if (!res.headersSent) {
            res.writeHead(504);
            res.end();
        }
    });
    lsReq.on('error', (err) => {
        if (stoppingProxy || res.destroyed || res.socket?.destroyed)
            return;
        electron_log_1.default.error('[Proxy] GetAvailableModels forward error:', err.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end();
        }
    });
    trackUpstream(lsReq);
    lsReq.write(reqBody);
    lsReq.end();
}
// ─── Main Request Handler ─────────────────────────────────────────────────
function handleRequest(req, res) {
    let requestUrl;
    try {
        req.url = (req.url || '/').replace(/^.*\/dummy_path_padding/, '');
        // Strip binary patch padding (from LS hostname replacement)
        req.url = req.url.replace(/\/v1internal\/x{7}/, '');
        // This listener routes fixed upstreams; authority-form targets must never replace them.
        if (!req.url.startsWith('/') || /^[\\/]{2}/.test(req.url))
            throw new Error('Invalid target');
        requestUrl = new URL(req.url, 'http://localhost');
    }
    catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid request target' } }));
        return;
    }
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
    if (req.method === 'GET' && requestUrl.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify((0, customRequest_1.getProxyMetrics)()));
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
        if (bodyRejected || rejectDuringShutdown(res))
            return;
        const fullBody = Buffer.concat(bodyChunks);
        const bodyStr = fullBody.toString('utf-8');
        electron_log_1.default.info(`[Proxy] Request: ${req.method} ${req.url}`);
        // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
        if (req.url.startsWith('/GetAvailableModels')) {
            const gavParsed = new URL(req.url, 'http://127.0.0.1');
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
        if (req.url.includes('/v1internal:fetchAvailableModels')) {
            electron_log_1.default.info('[Proxy] Intercepting fetchAvailableModels request');
            const targetUrl = cloudCodeRouting?.resolve(req.headers) || 'https://daily-cloudcode-pa.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const fwdHeaders = forwardingHeaders(req.headers);
            fwdHeaders['host'] = parsedUrl.host;
            fwdHeaders['content-length'] = String(fullBody.length);
            delete fwdHeaders['accept-encoding'];
            const fwdOptions = {
                method: req.method,
                headers: fwdHeaders,
            };
            let responded = false;
            const reply = (catalog = {}) => {
                if (responded || res.headersSent || res.writableEnded || res.destroyed || res.socket?.destroyed)
                    return;
                responded = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(customCloudCodeCatalog(catalog)));
            };
            const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
                const chunks = [];
                let length = 0;
                googleRes.on('data', (chunk) => {
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    length += bytes.length;
                    if (length > 8 * 1024 * 1024) {
                        reply();
                        googleReq.destroy();
                        return;
                    }
                    chunks.push(bytes);
                });
                googleRes.on('error', () => reply());
                googleRes.on('aborted', () => reply());
                googleRes.on('end', () => {
                    if (!googleRes.statusCode || googleRes.statusCode < 200 || googleRes.statusCode >= 300) {
                        reply();
                        return;
                    }
                    try {
                        reply(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    }
                    catch {
                        reply();
                    }
                });
            });
            // Install before headers arrive: an upstream that never sends headers still gets a bounded fallback.
            googleReq.setTimeout(30000, () => {
                reply();
                googleReq.destroy();
            });
            googleReq.on('error', () => reply());
            trackUpstream(googleReq);
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
                                ...getAdvertisedModelCapabilities(m),
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
                            name: m.name,
                            version: '1.0',
                            displayName: m.displayName,
                            description: m.description,
                            ...getAdvertisedModelCapabilities(m),
                            inputTokenLimit: (0, modelUtils_1.detectModelCapabilities)(m).maxTokens,
                            outputTokenLimit: (0, modelUtils_1.detectModelCapabilities)(m).maxOutputTokens,
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
                            name: m.name,
                            version: '1.0',
                            displayName: m.displayName,
                            description: m.description,
                            ...getAdvertisedModelCapabilities(m),
                            inputTokenLimit: (0, modelUtils_1.detectModelCapabilities)(m).maxTokens,
                            outputTokenLimit: (0, modelUtils_1.detectModelCapabilities)(m).maxOutputTokens,
                            supportedGenerationMethods: ['generateContent', 'countTokens'],
                        }));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ models: mappedCustom }));
                    }
                });
            });
            googleReq.on('error', (err) => {
                if (stoppingProxy || res.destroyed || res.writableEnded || res.socket?.destroyed)
                    return;
                electron_log_1.default.error('[Proxy] Google models list request error:', err);
                const customModels = loadCustomModels();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    models: customModels.map((m) => ({
                        name: m.name,
                        displayName: m.displayName,
                        description: m.description,
                        ...getAdvertisedModelCapabilities(m),
                        supportedGenerationMethods: ['generateContent'],
                    })),
                }));
            });
            trackUpstream(googleReq);
            googleReq.end();
            return;
        }
        // 3. Intercept Cloud Code generation stream or non-stream requests
        const isCloudCodeStream = req.url.includes('/v1internal:streamGenerateContent') || req.url.includes('/v1internal:generateContent');
        if (req.method === 'POST' && isCloudCodeStream) {
            try {
                const reqJson = JSON.parse(bodyStr);
                const modelName = reqJson.model;
                const modelId = reqJson.modelId ?? reqJson.model_id;
                electron_log_1.default.info(`[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`);
                {
                    const customModels = loadCustomModels();
                    const actualGeminiBody = { ...(reqJson.request || reqJson) };
                    if (typeof reqJson.sessionId === 'string')
                        actualGeminiBody.sessionId = reqJson.sessionId;
                    if (typeof reqJson.conversationId === 'string')
                        actualGeminiBody.conversationId = reqJson.conversationId;
                    if (!actualGeminiBody.labels && reqJson.labels && typeof reqJson.labels === 'object')
                        actualGeminiBody.labels = reqJson.labels;
                    const prepared = subagentRouting_1.subagentRouting.prepareRequest(actualGeminiBody, (selector) => (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, selector)?.name);
                    const matchedCustomModel = prepared.modelName
                        ? (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, prepared.modelName)
                        : matchCustomModel(customModels, modelName, modelId);
                    if (matchedCustomModel) {
                        electron_log_1.default.info(`[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`);
                        const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
                        // Resolve fileData URIs then route to translator
                        resolveFileData(prepared.body, req.headers, res).then(() => {
                            handleCustomModelRequest(res, matchedCustomModel, prepared.body, isStream);
                        });
                        return;
                    }
                    // Restore history and expose custom subagent selectors to native parents,
                    // preserving the original placement of Cloud Code envelope metadata.
                    const nativeBody = {
                        ...(reqJson.request || reqJson),
                        contents: prepared.body.contents,
                        tools: prepared.body.tools,
                    };
                    const forwarded = reqJson.request ? { ...reqJson, request: nativeBody } : { ...reqJson, ...nativeBody };
                    proxyToGoogle(req, res, Buffer.from(JSON.stringify(forwarded)), hasSubagentTool(actualGeminiBody)
                        ? {
                            context: prepared.context,
                            resolve: (selector) => (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, selector)?.name,
                        }
                        : undefined);
                    return;
                }
            }
            catch (err) {
                if (err instanceof subagentRouting_1.SubagentRoutingError) {
                    res.writeHead(err.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: err.message } }));
                    return;
                }
                electron_log_1.default.error('[Proxy] Failed to parse Cloud Code stream body:', err);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Invalid Cloud Code generation request body' } }));
                return;
            }
        }
        // 4. Intercept standard generateContent / streamGenerateContent request
        const generateMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
        const streamMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);
        const isGenerate = !!generateMatch;
        const isStandardStream = !!streamMatch;
        if (req.method === 'POST' && (isGenerate || isStandardStream)) {
            let matchedModelName;
            try {
                matchedModelName = decodeURIComponent(isGenerate ? generateMatch[1] : streamMatch[1]);
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Invalid model URL encoding' } }));
                return;
            }
            const customModels = loadCustomModels();
            try {
                const geminiBody = JSON.parse(bodyStr);
                const prepared = subagentRouting_1.subagentRouting.prepareRequest(geminiBody, (selector) => (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, selector)?.name);
                const matchedCustomModel = prepared.modelName
                    ? (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, prepared.modelName)
                    : matchCustomModel(customModels, matchedModelName);
                if (matchedCustomModel) {
                    resolveFileData(prepared.body, req.headers, res).then(() => {
                        handleCustomModelRequest(res, matchedCustomModel, prepared.body, isStandardStream, false);
                    });
                    return;
                }
                proxyToGoogle(req, res, Buffer.from(JSON.stringify({ ...geminiBody, contents: prepared.body.contents, tools: prepared.body.tools })), hasSubagentTool(geminiBody)
                    ? {
                        context: prepared.context,
                        resolve: (selector) => (0, subagentModels_1.resolveConfiguredSubagentModel)(customModels, selector)?.name,
                    }
                    : undefined);
                return;
            }
            catch (e) {
                electron_log_1.default.error('[Proxy] JSON parse error in request body:', e);
                res.writeHead(e instanceof subagentRouting_1.SubagentRoutingError ? e.status : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: { message: e instanceof subagentRouting_1.SubagentRoutingError ? e.message : 'Invalid JSON request body' },
                }));
                return;
            }
        }
        // 5. Fallback: transparent proxy to Google
        proxyToGoogle(req, res, fullBody);
    });
}
// ─── Server Start/Stop ────────────────────────────────────────────────────
async function startProxy(options = {}) {
    if (stoppingProxy)
        await stoppingProxy;
    if (server?.listening && proxyPort)
        return proxyPort;
    if (startingProxy)
        return startingProxy;
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
        throw new Error('Proxy port must be an integer between 1 and 65535');
    }
    if (options.shutdownGraceMs !== undefined &&
        (!Number.isInteger(options.shutdownGraceMs) || options.shutdownGraceMs < 0 || options.shutdownGraceMs > 60000)) {
        throw new Error('Proxy shutdown grace must be an integer between 0 and 60000 milliseconds');
    }
    serviceDataDirectory = options.dataDirectory ? path.resolve(options.dataDirectory) : undefined;
    languageServerRoutingEnabled = options.allowLanguageServerRouting !== false;
    shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    cloudCodeRouting = options.ideCloudCodeRouting ? new cloudCodeRouting_1.CloudCodeRouting() : undefined;
    const requiredPort = options.port ?? (0, listen_1.getRequiredProxyPort)(require('electron').app.getAppPath());
    const newServer = http.createServer((req, res) => {
        if (!(0, loopbackSecurity_1.guardLoopbackRequest)(req, res, currentLanguageServerPort()))
            return;
        // Already-connected clients can pipeline another request while the listener drains.
        // Do not start new upstream work after cancellation has begun.
        if (rejectDuringShutdown(res))
            return;
        if (!options.handleManagement?.(req, res))
            handleRequest(req, res);
    });
    server = newServer;
    (0, shared_1.startCleanupInterval)();
    startingProxy = (0, listen_1.listenProxy)(newServer, requiredPort ?? 50999, requiredPort === undefined)
        .then((port) => {
        proxyPort = port;
        electron_log_1.default.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
        return proxyPort;
    })
        .catch((error) => {
        (0, shared_1.stopCleanupInterval)();
        server = null;
        proxyPort = 0;
        electron_log_1.default.error('[Proxy] Startup failed:', error);
        throw error;
    })
        .finally(() => {
        startingProxy = null;
    });
    return startingProxy;
}
function stopProxy() {
    if (stoppingProxy)
        return stoppingProxy;
    stoppingProxy = (async () => {
        // A shutdown requested during startup must also close the listener once ready.
        if (startingProxy) {
            try {
                await startingProxy;
            }
            catch {
                // A failed start already cleared its server and cleanup interval.
            }
        }
        (0, shared_1.stopCleanupInterval)();
        (0, customRequest_1.stopCustomRequests)();
        cloudCodeRouting?.clear();
        if (server) {
            const closingServer = server;
            await new Promise((resolve) => {
                // Native upstream streams and incomplete HTTP bodies are not necessarily
                // canceled by stopCustomRequests. Never let them hold application quit open.
                const timer = setTimeout(() => {
                    closingServer.closeAllConnections();
                    stopUpstreams();
                }, shutdownGraceMs);
                timer.unref();
                closingServer.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            electron_log_1.default.info('[Proxy] Server stopped');
        }
        // A disconnected downstream or buffered catalogue response may leave an
        // upstream alive even after the inbound listener has finished closing.
        stopUpstreams();
        // Final native responses may create routing markers while shutdown drains.
        subagentRouting_1.subagentRouting.clear();
        server = null;
        proxyPort = 0;
    })().finally(() => {
        stoppingProxy = null;
    });
    return stoppingProxy;
}
function getProxyPort() {
    return proxyPort;
}
//# sourceMappingURL=proxy.js.map