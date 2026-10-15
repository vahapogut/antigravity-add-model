"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProxyMetrics = getProxyMetrics;
exports.stopCustomRequests = stopCustomRequests;
exports.buildFallbackChain = buildFallbackChain;
exports.runCustomModelRequest = runCustomModelRequest;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto_1 = require("crypto");
const string_decoder_1 = require("string_decoder");
const providers_1 = require("../providers");
const googleAccounts_1 = require("../googleAccounts");
const googlePoolPolicy_1 = require("../googlePoolPolicy");
const googleAccessErrors_1 = require("../googleAccessErrors");
const diagnostics_1 = require("../diagnostics");
const registry = __importStar(require("./registry"));
const circuitBreaker_1 = require("./circuitBreaker");
const requestOptions_1 = require("./requestOptions");
const shared_1 = require("./shared");
const utils_1 = require("./translators/utils");
const subagentRouting_1 = require("./subagentRouting");
const subagentModels_1 = require("./subagentModels");
const opencodeFingerprint_1 = require("./opencodeFingerprint");
const circuits = new circuitBreaker_1.CircuitBreaker();
const controllers = new Set();
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
function getProxyMetrics() {
    return { ...counts, circuits: circuits.snapshot() };
}
function stopCustomRequests() {
    for (const controller of controllers)
        controller.abort();
}
class UpstreamError extends Error {
    constructor(message, status = 502, retryable = true, retryAfter = 0, mayFallback = true, googleRateLimit) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.retryAfter = retryAfter;
        this.mayFallback = mayFallback;
        this.googleRateLimit = googleRateLimit;
    }
}
function asUpstreamError(error) {
    if (error instanceof subagentRouting_1.SubagentRoutingError)
        return new UpstreamError(error.message, error.status, false, 0, false);
    if (error instanceof googleAccounts_1.GoogleAccountError)
        return new UpstreamError(error.message, error.status, false);
    return error instanceof UpstreamError ? error : new UpstreamError('Upstream connection failed.');
}
function clearRequestState(key) {
    shared_1.activeStreamContexts.delete(key);
    shared_1.modelReasoningContent.delete(key);
    shared_1.modelToolCallIds.delete(key);
    for (const timestamps of Object.values(shared_1.stateTimestamps))
        timestamps.delete(key);
}
function envelope(value, cloud) {
    return cloud ? { response: value, traceId: '', metadata: {} } : value;
}
function validateToolArguments(value) {
    let parsed = value;
    try {
        if (typeof value === 'string')
            parsed = JSON.parse(value || '{}');
    }
    catch {
        throw new UpstreamError('Upstream returned incomplete tool arguments.', 502, false, 0, false);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new UpstreamError('Upstream returned invalid tool arguments.', 502, false, 0, false);
}
/** Read only a bounded error body for classification; never expose or persist its contents. */
async function boundedErrorBody(upstream) {
    const chunks = [];
    let size = 0;
    const limit = 16 * 1024;
    const timer = setTimeout(() => upstream.destroy(), 1000);
    timer.unref();
    try {
        for await (const chunk of upstream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const bounded = bytes.subarray(0, limit - size);
            chunks.push(bounded);
            size += bounded.length;
            if (size >= limit)
                break;
        }
    }
    catch {
        // Diagnostics must not replace the original HTTP status on a broken response.
    }
    finally {
        clearTimeout(timer);
        upstream.destroy();
    }
    return Buffer.concat(chunks).toString('utf8').trim();
}
/** Classify schema errors without returning provider text, credentials or echoed prompts. */
function toolSchemaErrorHint(body) {
    let message = body;
    if (message.startsWith('{') || message.startsWith('[')) {
        try {
            const data = JSON.parse(message);
            message = [
                data?.message,
                data?.error?.message,
                ...(Array.isArray(data?.errors) ? data.errors.map((item) => item?.message) : []),
            ]
                .filter((value) => typeof value === 'string')
                .join('\n');
        }
        catch {
            return '';
        }
    }
    if (!/\b(?:schema|parameters)\b/i.test(message) || !/\b(?:invalid|rejected|not of type|must be)\b/i.test(message))
        return '';
    const bounds = [
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'minProperties',
        'maxProperties',
        'minContains',
        'maxContains',
    ].filter((keyword) => new RegExp(`\\b${keyword}\\b`).test(message));
    return bounds.length
        ? ` Tool schema rejected; check non-negative integer constraints (${bounds.join(', ')}).`
        : ' Tool schema rejected; check the declared parameter types and constraints.';
}
function delay(ms, signal) {
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
function waitForDrain(res) {
    if (!res.writableNeedDrain)
        return Promise.resolve();
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
function buildFallbackChain(primary, allModels) {
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
async function runCustomModelRequest(res, primary, originalBody, isStream, allModels, cloudEnvelope = true, kind = 'request') {
    const resolveSubagent = (selector) => (0, subagentModels_1.resolveConfiguredSubagentModel)(allModels, selector)?.name;
    let prepared;
    try {
        prepared = subagentRouting_1.subagentRouting.prepareRequest(originalBody, resolveSubagent);
        originalBody = prepared.body;
        if (prepared.modelName)
            primary = (0, subagentModels_1.resolveConfiguredSubagentModel)(allModels, prepared.modelName);
    }
    catch (error) {
        res.writeHead(error instanceof subagentRouting_1.SubagentRoutingError ? error.status : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: error instanceof subagentRouting_1.SubagentRoutingError ? error.message : 'Invalid subagent routing request.' },
        }));
        return;
    }
    // Resolve once before trimming/translating; retries and fallback providers
    // must preserve the primary model's choice for this compaction operation.
    const compactionEffort = (0, requestOptions_1.isAntigravityCompactionRequest)(originalBody) ? primary.compactionReasoningEffort : undefined;
    const toolSchemas = (0, utils_1.collectToolSchemas)(originalBody);
    const controller = new AbortController();
    const { signal } = controller;
    const requestId = (0, crypto_1.randomUUID)();
    controllers.add(controller);
    counts.requests += 1;
    counts.active += 1;
    const onClose = () => {
        if (!res.writableEnded)
            controller.abort();
    };
    res.once('close', onClose);
    let completed = false;
    let upstreamOutput = false;
    const deadline = Date.now() + (primary.retryBudgetMs ?? Math.max(primary.timeout ?? 120000, 120000));
    let failure = new UpstreamError('No configured model is currently available.', 503);
    let effectiveModel = primary;
    const diagnostic = (0, diagnostics_1.beginDiagnosticRequest)({
        model: primary.name,
        provider: primary.provider,
        stream: isStream,
        kind,
    });
    const writeCandidate = (candidate) => {
        if (signal.aborted || res.destroyed)
            throw new Error('Cancelled');
        prepared.context.modelName = effectiveModel.name;
        const routed = subagentRouting_1.subagentRouting.rewriteCandidate(candidate, prepared.context, resolveSubagent);
        if (!res.headersSent)
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            });
        res.write(`data: ${JSON.stringify(envelope({ candidates: [routed] }, cloudEnvelope))}\n\n`);
    };
    try {
        const chain = buildFallbackChain(primary, allModels);
        modelLoop: for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
            const model = chain[modelIndex];
            if (signal.aborted)
                break;
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
            if (modelIndex > 0)
                counts.fallbacks += 1;
            let modelFailed = false;
            const retries = kind === 'generation-test' ? 0 : Math.min(5, Math.max(0, model.maxRetries ?? 3));
            const cloudCode = model.provider === 'google-cloudcode';
            const accountCount = cloudCode && kind !== 'generation-test'
                ? (model.googleAccounts || []).filter((account) => account.enabled !== false).length
                : 0;
            const attemptsAllowed = retries + Math.max(0, accountCount - 1);
            for (let attempt = 0; attempt <= attemptsAllowed; attempt++) {
                const stateKey = (0, crypto_1.randomUUID)();
                let request;
                let accountLease;
                let totalTimer;
                let headerLatencyMs;
                const abort = () => request?.destroy(new Error('Cancelled'));
                try {
                    if (signal.aborted)
                        break;
                    const remaining = deadline - Date.now();
                    if (remaining <= 0)
                        throw new UpstreamError('Request retry budget exhausted.', 504, false);
                    effectiveModel = model;
                    diagnostic.resetUsage();
                    const format = (0, providers_1.resolveApiFormat)(model.provider, model.apiFormat);
                    const externalName = model.externalModelName || model.name.replace(/^models\//, '');
                    if (cloudCode) {
                        const identity = originalBody.sessionId || originalBody.conversationId;
                        accountLease = await (0, googleAccounts_1.acquireGoogleAccount)(model.name, model.googleAccounts || [], model.googlePool, typeof identity === 'string' ? identity : undefined, externalName.replace(/^models\//, ''));
                        if (signal.aborted)
                            break;
                    }
                    let payload;
                    let url;
                    let headers;
                    try {
                        const outputBudget = model.maxOutputTokens ??
                            Number(originalBody.generationConfig?.maxOutputTokens ||
                                (model.contextWindow ? Math.min(4000, Math.max(1, Math.floor(model.contextWindow / 4))) : 0));
                        const body = (0, requestOptions_1.trimContext)(originalBody, model.contextWindow, outputBudget);
                        const effectiveModel = outputBudget ? { ...model, maxOutputTokens: outputBudget } : model;
                        payload = (0, requestOptions_1.applyRequestOptions)(registry.translateRequest(model.provider, body, externalName, format, stateKey), effectiveModel, format, isStream, compactionEffort);
                        let target = cloudCode || model.rawUrl
                            ? model.apiUrl
                            : registry.getProviderUrl(model.apiUrl, externalName, isStream, registry.getTranslator(model.provider, format));
                        const isOpencode = (0, opencodeFingerprint_1.isOpencodeProvider)(model.provider) ||
                            target.includes('opencode.ai') ||
                            (0, opencodeFingerprint_1.isOpencodeFreeModel)(externalName);
                        if (isOpencode) {
                            target = (0, opencodeFingerprint_1.normalizeOpencodeEndpoint)(target, externalName, format === 'openai' && target.endsWith('/responses'));
                        }
                        url = new URL(target);
                        if (!['http:', 'https:'].includes(url.protocol))
                            throw new Error('Unsupported endpoint protocol');
                        headers = registry.getProviderHeaders(model.provider, cloudCode ? '' : model.apiKey, format);
                        if (accountLease) {
                            url = new URL((0, googleAccounts_1.googleAccountEndpoint)(accountLease.account, model.apiUrl));
                            if (accountLease.account.authMode === 'antigravity' && !accountLease.account.project)
                                throw new Error('Prepare this Antigravity account in the model manager before generating a response');
                            url.pathname = `/v1internal:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
                            url.search = isStream ? '?alt=sse' : '';
                            headers.Authorization = `Bearer ${accountLease.account.accessToken}`;
                            headers['User-Agent'] = googleAccounts_1.GOOGLE_CLOUD_CODE_USER_AGENT;
                            const project = accountLease.account.project || model.googleProject;
                            payload = { model: externalName, ...(project ? { project } : {}), request: payload };
                        }
                        if (isOpencode) {
                            const identity = originalBody.sessionId || originalBody.conversationId;
                            const opencodeHeaders = (0, opencodeFingerprint_1.buildOpencodeHeaders)(model.apiKey, typeof identity === 'string' ? identity : requestId);
                            headers = { ...headers, ...opencodeHeaders };
                            if ((0, opencodeFingerprint_1.isOpencodeFreeModel)(externalName) || !model.apiKey || model.apiKey === 'none') {
                                payload = (0, opencodeFingerprint_1.prepareOpencodeFreeBody)(payload, format === 'openai' && url.pathname.endsWith('/responses'));
                            }
                        }
                        if (model.gateway) {
                            const identity = originalBody.conversationId || originalBody.sessionId;
                            if (typeof identity === 'string' && identity.trim()) {
                                // Stable across turns and safe as a header, even when callers use Unicode/control characters.
                                headers['x-antigravity-conversation-id'] = (0, crypto_1.createHash)('sha256').update(identity).digest('hex');
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
                        if (isOpencode) {
                            delete headers['x-opencode-request'];
                        }
                    }
                    catch (error) {
                        throw new UpstreamError(`Invalid model configuration: ${error.message}`, 400, false, 0, false);
                    }
                    counts.upstreamAttempts += 1;
                    const upstreamStartedAt = Date.now();
                    const upstream = await new Promise((resolve, reject) => {
                        request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers, rejectUnauthorized: !model.allowUnauthorized }, resolve);
                        request.once('error', reject);
                        request.setTimeout(model.idleTimeout ?? 30000, () => request?.destroy(new UpstreamError('Upstream idle timeout.', 504)));
                        totalTimer = setTimeout(() => request?.destroy(new UpstreamError('Upstream request timeout.', 504)), Math.min(model.timeout ?? 120000, remaining));
                        signal.addEventListener('abort', abort, { once: true });
                        request.end(JSON.stringify(payload));
                    });
                    headerLatencyMs = Date.now() - upstreamStartedAt;
                    const status = upstream.statusCode || 502;
                    if (status < 200 || status >= 300) {
                        const errorBody = status === 400 || status === 422 || (cloudCode && status === 429) ? await boundedErrorBody(upstream) : '';
                        const decision = cloudCode && status === 429
                            ? (0, googlePoolPolicy_1.classifyGoogleRateLimit)(errorBody, upstream.headers['retry-after'])
                            : undefined;
                        const retryAfter = decision?.retryAfterMs ?? (0, requestOptions_1.parseRetryAfter)(upstream.headers['retry-after']);
                        const hint = status === 400 || status === 422 ? toolSchemaErrorHint(errorBody) : '';
                        upstream.destroy();
                        throw new UpstreamError(`${cloudCode ? (0, googleAccessErrors_1.describeGoogleAccessError)(status).message : `Upstream returned HTTP ${status}.`}${hint}`, status, status === 408 || status === 429 || status >= 500, retryAfter, status !== 400 && status !== 422, decision);
                    }
                    if (isStream && String(upstream.headers['content-type']).includes('text/event-stream')) {
                        const decoder = new string_decoder_1.StringDecoder('utf8');
                        let buffer = '';
                        let dataLines = [];
                        let emitted = false;
                        let finalReason = false;
                        let terminal = false;
                        const event = () => {
                            const data = dataLines.join('\n');
                            dataLines = [];
                            if (!data)
                                return;
                            let chunk;
                            if (data.trim() === '[DONE]') {
                                terminal = true;
                                // Some compatible endpoints omit finish_reason. Flush remaining
                                // text/tools through validation, but never replay a finalized context.
                                if (format !== 'openai' || !shared_1.activeStreamContexts.has(stateKey))
                                    return;
                                chunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };
                            }
                            else {
                                try {
                                    chunk = JSON.parse(data);
                                }
                                catch {
                                    throw new UpstreamError('Upstream sent malformed SSE JSON.');
                                }
                            }
                            if (chunk.error || chunk.type === 'error')
                                throw new UpstreamError('Upstream reported a stream error.');
                            if (cloudCode && chunk.response)
                                chunk = chunk.response;
                            diagnostic.observe(chunk, format);
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.content ||
                                delta?.reasoning_content ||
                                delta?.reasoning ||
                                delta?.tool_calls?.length ||
                                chunk.content_block?.type === 'tool_use' ||
                                chunk.delta?.text ||
                                chunk.delta?.thinking ||
                                chunk.delta?.partial_json ||
                                chunk.candidates?.[0]?.content?.parts?.length)
                                upstreamOutput = true;
                            if (chunk.type === 'message_stop' ||
                                chunk.choices?.[0]?.finish_reason ||
                                chunk.candidates?.[0]?.finishReason)
                                terminal = true;
                            if ((chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'tool_use') ||
                                chunk.choices?.[0]?.finish_reason) {
                                const pending = shared_1.activeStreamContexts.get(stateKey)?.toolCalls || {};
                                // Validate a copy including this event before the translator appends
                                // its fragments and consumes the state. Never append to live state twice.
                                const completed = new Map(Object.entries(pending).map(([index, tool]) => [index, tool.arguments]));
                                if (format === 'openai' && Array.isArray(delta?.tool_calls)) {
                                    for (const tool of delta.tool_calls) {
                                        const index = String(tool.index ?? 0);
                                        completed.set(index, (completed.get(index) || '') + (tool.function?.arguments || ''));
                                    }
                                }
                                for (const args of completed.values())
                                    validateToolArguments(args);
                            }
                            const mapped = registry.translateStreamChunk(model.provider, chunk, stateKey, format, stateKey, toolSchemas);
                            if (mapped) {
                                if (mapped.content?.parts?.length)
                                    emitted = true;
                                if (mapped.finishReason && mapped.finishReason !== 'OTHER')
                                    finalReason = true;
                                // A role-only or empty completion must not commit headers and prevent fallback.
                                if (emitted)
                                    writeCandidate(mapped);
                            }
                        };
                        const drain = () => {
                            let index;
                            while ((index = buffer.indexOf('\n')) >= 0) {
                                const line = buffer.slice(0, index).replace(/\r$/, '');
                                buffer = buffer.slice(index + 1);
                                if (!line)
                                    event();
                                else if (line.startsWith('data:'))
                                    dataLines.push(line.slice(5).replace(/^ /, ''));
                            }
                        };
                        for await (const bytes of upstream) {
                            if (signal.aborted)
                                throw new Error('Cancelled');
                            buffer += decoder.write(bytes);
                            if (buffer.length + dataLines.join('').length > 2 * 1024 * 1024)
                                throw new UpstreamError('Upstream SSE event is too large.', 502, false);
                            drain();
                            await waitForDrain(res);
                        }
                        buffer += decoder.end();
                        if (buffer)
                            buffer += '\n';
                        drain();
                        event();
                        if (!emitted)
                            throw new UpstreamError('Upstream returned an empty stream.');
                        if (!terminal)
                            throw new UpstreamError('Upstream stream ended before completion.', 502, false);
                        if (!finalReason)
                            writeCandidate({ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 });
                    }
                    else {
                        let size = 0;
                        const chunks = [];
                        for await (const bytes of upstream) {
                            size += bytes.length;
                            if (size > 20 * 1024 * 1024)
                                throw new UpstreamError('Upstream response exceeds 20 MB.', 502, false);
                            chunks.push(bytes);
                        }
                        let parsed;
                        const rawBody = Buffer.concat(chunks).toString('utf8');
                        try {
                            parsed = JSON.parse(rawBody);
                        }
                        catch {
                            const sseParsed = (0, opencodeFingerprint_1.parseSSEToOpenAIResponse)(rawBody, externalName);
                            if (sseParsed) {
                                parsed = sseParsed;
                            }
                            else {
                                throw new UpstreamError('Upstream returned invalid JSON.');
                            }
                        }
                        if (parsed.error) {
                            throw new UpstreamError(typeof parsed.error?.message === 'string' ? parsed.error.message : 'Upstream returned an error response.');
                        }
                        if (cloudCode && parsed.response)
                            parsed = parsed.response;
                        diagnostic.observe(parsed, format);
                        if ((format === 'openai' && !parsed.choices?.[0]?.message) ||
                            (format === 'anthropic' && !Array.isArray(parsed.content)))
                            throw new UpstreamError('Upstream returned an invalid completion.');
                        if (parsed.choices?.[0]?.message?.tool_calls?.length) {
                            upstreamOutput = true;
                            for (const tool of parsed.choices[0].message.tool_calls)
                                validateToolArguments(tool.function?.arguments);
                        }
                        // Some compatible endpoints return a complete JSON response even when stream=true.
                        const mapped = registry.translateResponse(model.provider, parsed, stateKey, format, toolSchemas);
                        if (!mapped?.candidates?.length)
                            throw new UpstreamError('Upstream returned no candidates.');
                        if (kind === 'generation-test' &&
                            !mapped.candidates.some((candidate) => {
                                const content = candidate
                                    ?.content;
                                return (Array.isArray(content?.parts) &&
                                    content.parts.some((part) => part?.thought !== true && typeof part?.text === 'string' && part.text.trim()));
                            })) {
                            // The short test can exhaust its output budget despite a healthy account.
                            // Record the accepted upstream response before the logical test failure.
                            accountLease?.release({ status, latencyMs: headerLatencyMs });
                            throw new UpstreamError('The provider did not return generated text. Check the model and test output budget.', 502, false, 0, false);
                        }
                        if (isStream) {
                            for (const candidate of mapped.candidates)
                                writeCandidate(candidate);
                        }
                        else {
                            prepared.context.modelName = effectiveModel.name;
                            const routed = subagentRouting_1.subagentRouting.rewriteResponse(mapped, prepared.context, resolveSubagent);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(envelope(routed, cloudEnvelope)));
                        }
                    }
                    circuits.succeed(circuitKey);
                    completed = true;
                    accountLease?.release({ status, latencyMs: headerLatencyMs });
                    counts.succeeded += 1;
                    res.end();
                    return;
                }
                catch (error) {
                    failure = asUpstreamError(error);
                    accountLease?.release({
                        status: failure.status,
                        retryAfterMs: failure.googleRateLimit
                            ? failure.googleRateLimit.retryAfterMs
                            : failure.retryAfter || undefined,
                        cooldownReason: failure.googleRateLimit?.reason,
                        cancelled: signal.aborted,
                    });
                    if (signal.aborted) {
                        circuits.cancel(circuitKey);
                        break modelLoop;
                    }
                    if (res.headersSent || upstreamOutput) {
                        circuits.fail(circuitKey, model.circuitBreaker);
                        break modelLoop;
                    }
                    if (accountLease &&
                        attempt < accountCount - 1 &&
                        [401, 403, 408, 429, 500, 502, 503, 504].includes(failure.status)) {
                        counts.accountSwitches += 1;
                        continue;
                    }
                    if (failure.retryable && attempt < retries && Date.now() < deadline) {
                        counts.retries += 1;
                        // Tear down the old attempt before waiting; timeout and error cannot each schedule a retry.
                        request?.destroy();
                        if (totalTimer)
                            clearTimeout(totalTimer);
                        signal.removeEventListener('abort', abort);
                        await delay(Math.min(failure.retryAfter || 500 * 2 ** attempt, Math.max(1, deadline - Date.now())), signal);
                    }
                    else {
                        modelFailed = true;
                        break;
                    }
                }
                finally {
                    if (totalTimer)
                        clearTimeout(totalTimer);
                    signal.removeEventListener('abort', abort);
                    request?.destroy();
                    accountLease?.release();
                    clearRequestState(stateKey);
                }
            }
            if (modelFailed)
                circuits.fail(circuitKey, model.circuitBreaker);
            else
                circuits.cancel(circuitKey);
            if (!failure.mayFallback)
                break;
        }
        if (!signal.aborted && !res.writableEnded && !res.destroyed) {
            if (res.headersSent)
                res.write(`event: error\ndata: ${JSON.stringify({ error: { message: failure.message, code: failure.status } })}\n\n`);
            else {
                res.writeHead(failure.status, { 'Content-Type': 'application/json' });
                res.write(JSON.stringify({ error: { message: failure.message } }));
            }
            res.end();
        }
    }
    catch {
        if (!signal.aborted && !res.writableEnded && !res.destroyed) {
            if (!res.headersSent)
                res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Model request failed.' } }));
        }
    }
    finally {
        res.removeListener('close', onClose);
        controllers.delete(controller);
        counts.active -= 1;
        diagnostic.finish({
            outcome: signal.aborted ? 'cancelled' : completed ? 'succeeded' : 'failed',
            status: signal.aborted ? undefined : completed ? 200 : failure.status,
            model: effectiveModel.name,
            provider: effectiveModel.provider,
        });
        if (!completed) {
            if (signal.aborted)
                counts.cancelled += 1;
            else
                counts.failed += 1;
        }
    }
}
//# sourceMappingURL=customRequest.js.map