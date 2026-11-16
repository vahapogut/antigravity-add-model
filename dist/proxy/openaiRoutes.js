"use strict";
/**
 * OpenAI-compatible route handlers: `GET /v1/models` and (later) `POST /v1/chat/completions`.
 *
 * All collaborators come in through `OpenAIRouteDeps` (design Decision 6), so tests can
 * pass fakes and no network, `custom_models.json` or IDE is involved.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDefaults = withDefaults;
exports.resolveChatModel = resolveChatModel;
exports.handleOpenAIModels = handleOpenAIModels;
exports.handleChatCompletions = handleChatCompletions;
const crypto_1 = require("crypto");
const electron_log_1 = __importDefault(require("electron-log"));
const catalogResolver_mjs_1 = require("../norm/catalogResolver.mjs");
const streamTransformer_mjs_1 = require("../norm/streamTransformer.mjs");
const openaiCompat_1 = require("./openaiCompat");
const capturedResponse_1 = require("./capturedResponse");
const defaultResolveSpec = (modelId, providerUrl) => catalogResolver_mjs_1.defaultCatalogResolver.resolveModelSpec(modelId, providerUrl);
function withDefaults(deps) {
    return {
        loadModels: deps.loadModels,
        matchModel: deps.matchModel,
        runModel: deps.runModel,
        resolveSpec: deps.resolveSpec ?? defaultResolveSpec,
        now: deps.now ?? Date.now,
        newId: deps.newId ?? crypto_1.randomUUID,
        startHeartbeat: deps.startHeartbeat ?? ((res) => (0, streamTransformer_mjs_1.startSseHeartbeat)(res)),
        createTransformer: deps.createTransformer ?? ((opts) => new streamTransformer_mjs_1.StreamTransformer(opts)),
    };
}
/**
 * Decision 5 / R4.1: the ids listed by `/v1/models` win (first-wins order of R3.5),
 * then `matchModel` handles full names, catalog slugs, local slugs and placeholder ids.
 */
function resolveChatModel(models, selector, matchModel) {
    const listed = (0, openaiCompat_1.buildOpenAIModelIndex)(models).get(selector);
    if (listed)
        return listed;
    return matchModel(models, selector);
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
/** R3.1, R3.10, R3.11: OpenAI-format model list built only from local data. */
function handleOpenAIModels(res, deps) {
    const d = withDefaults(deps);
    let models;
    try {
        models = d.loadModels();
    }
    catch {
        sendJson(res, 500, (0, openaiCompat_1.openAIError)('The model list could not be loaded.', 'api_error', null));
        return;
    }
    try {
        sendJson(res, 200, (0, openaiCompat_1.buildOpenAIModelList)(models, d.resolveSpec, d.now()));
    }
    catch {
        if (!res.headersSent) {
            sendJson(res, 500, (0, openaiCompat_1.openAIError)('The model list could not be loaded.', 'api_error', null));
        }
    }
}
// ── POST /v1/chat/completions ──────────────────────────────────────────────
const UNEXPECTED_ERROR_MESSAGE = 'The chat completion request failed unexpectedly.';
/** True when nothing more may be written to the client response. */
function responseClosed(res) {
    return res.writableEnded || res.destroyed;
}
/** Writes a JSON error/success body only when the response is still open and uncommitted. */
function sendJsonIfOpen(res, status, body) {
    if (responseClosed(res) || res.headersSent)
        return false;
    sendJson(res, status, body);
    return true;
}
function sendUnexpectedError(res) {
    sendJsonIfOpen(res, 500, (0, openaiCompat_1.openAIError)(UNEXPECTED_ERROR_MESSAGE, 'api_error', null));
}
/**
 * R4.1, R4.2, R4.11–R4.13, R7.1–R7.4, R7.9: validates the body, maps it to a GeminiBody,
 * resolves the Model_Selector and hands the request to `runModel` exactly once.
 */
function handleChatCompletions(req, res, bodyStr, deps) {
    try {
        const d = withDefaults(deps);
        const request = (0, openaiCompat_1.parseChatRequest)(bodyStr);
        const geminiBody = (0, openaiCompat_1.mapChatRequestToGemini)(request);
        const selector = request.model;
        const models = d.loadModels();
        const model = resolveChatModel(models, selector, d.matchModel);
        if (!model) {
            sendJsonIfOpen(res, 404, (0, openaiCompat_1.openAIError)(`The model '${selector}' does not exist.`, 'invalid_request_error', 'model_not_found'));
            return;
        }
        const isStream = (0, openaiCompat_1.isStreamRequest)(request);
        electron_log_1.default.info(`[Proxy] OpenAI chat completion: model=${selector} stream=${isStream}`);
        const ctx = {
            req,
            res,
            deps: d,
            selector,
            model,
            models,
            geminiBody,
            meta: { id: 'chatcmpl-' + d.newId(), created: Math.floor(d.now() / 1000), model: selector },
        };
        if (isStream)
            runStreamingCompletion(ctx);
        else
            runNonStreamingCompletion(ctx);
    }
    catch (error) {
        if (error instanceof openaiCompat_1.ChatRequestError) {
            sendJsonIfOpen(res, error.status, (0, openaiCompat_1.openAIError)(error.message, 'invalid_request_error', error.code));
            return;
        }
        electron_log_1.default.error('[Proxy] OpenAI chat completion failed:', error instanceof Error ? error.message : String(error));
        sendUnexpectedError(res);
    }
}
/**
 * Calls `runModel` once against the capture. A synchronous throw or a rejected promise
 * goes to `onUnexpected`; a promise that resolves without the capture ending goes to
 * `onSettledWithoutEnd`.
 */
function startRunModel(ctx, capture, isStream, onUnexpected, onSettledWithoutEnd) {
    let promise;
    try {
        promise = Promise.resolve(ctx.deps.runModel(capture.asServerResponse(), ctx.model, ctx.geminiBody, isStream, ctx.models, false));
    }
    catch (error) {
        onUnexpected(error);
        return;
    }
    promise.then(() => {
        if (!capture.writableEnded && !capture.destroyed)
            onSettledWithoutEnd();
    }, (error) => onUnexpected(error));
}
/** Merges captured SSE candidate events into one Gemini response (defensive; non-stream runs write JSON). */
function mergeCandidateEvents(events) {
    const parts = [];
    let finishReason;
    let usageMetadata;
    for (const event of events) {
        const candidate = event.candidates?.[0];
        if (Array.isArray(candidate?.content?.parts))
            parts.push(...candidate.content.parts);
        if (typeof candidate?.finishReason === 'string' && candidate.finishReason)
            finishReason = candidate.finishReason;
        if (event.usageMetadata)
            usageMetadata = event.usageMetadata;
    }
    const merged = { candidates: [{ content: { role: 'model', parts }, finishReason }] };
    if (usageMetadata)
        merged.usageMetadata = usageMetadata;
    return merged;
}
function parseGeminiBody(body) {
    try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** R5.1, R5.5, R5.9, R7.5, R7.6, R7.8, R7.9: non-streaming completion. */
function runNonStreamingCompletion(ctx) {
    const { res, deps, meta } = ctx;
    let settled = false;
    let clientGone = false;
    const events = [];
    let streamError;
    const respond = (status, body) => {
        if (settled || clientGone)
            return;
        settled = true;
        sendJsonIfOpen(res, status, body);
    };
    const respondUnexpected = (error) => {
        if (settled || clientGone)
            return;
        electron_log_1.default.error('[Proxy] OpenAI chat completion failed:', error instanceof Error ? error.message : String(error));
        settled = true;
        sendUnexpectedError(res);
    };
    const onEnd = (summary) => {
        if (summary.statusCode >= 400) {
            const mapped = (0, openaiCompat_1.upstreamErrorBody)(summary.statusCode, summary.body ?? '');
            respond(mapped.status, mapped.body);
            return;
        }
        if (streamError) {
            const status = streamError.status !== undefined && streamError.status >= 400 ? streamError.status : 502;
            const mapped = (0, openaiCompat_1.upstreamErrorBody)(status, JSON.stringify({ error: { message: streamError.message } }));
            respond(mapped.status, mapped.body);
            return;
        }
        let gemini;
        if (summary.body !== undefined && summary.body.trim() !== '')
            gemini = parseGeminiBody(summary.body);
        else if (events.length > 0)
            gemini = mergeCandidateEvents(events);
        if (!gemini) {
            respond(502, (0, openaiCompat_1.openAIError)('The upstream response could not be read.', 'api_error', null));
            return;
        }
        respond(200, (0, openaiCompat_1.geminiToChatCompletion)(gemini, meta, deps.newId));
    };
    // Sink callbacks run synchronously inside runModel's writes, so they must never throw.
    const sink = {
        onCandidateEvent: (event) => {
            events.push(event);
        },
        onStreamError: (message, status) => {
            if (!streamError)
                streamError = { message, status };
        },
        onEnd: (summary) => {
            try {
                onEnd(summary);
            }
            catch (error) {
                respondUnexpected(error);
            }
        },
    };
    const capture = new capturedResponse_1.CapturedResponse(sink);
    // R7.8: a client disconnect aborts the in-flight upstream request through the capture.
    res.once('close', () => {
        if (settled || res.writableEnded)
            return;
        clientGone = true;
        capture.destroy();
    });
    startRunModel(ctx, capture, false, respondUnexpected, () => respond(502, (0, openaiCompat_1.openAIError)('The upstream request ended without a response.', 'api_error', null)));
}
const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
};
function sseData(payload) {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}
/** Maps a stream error (optional status) to the status and OpenAI_Error_Body to report. */
function streamErrorBody(message, status) {
    const effective = status !== undefined && status >= 400 && status <= 599 ? status : 502;
    return (0, openaiCompat_1.upstreamErrorBody)(effective, JSON.stringify({ error: { message } }));
}
/**
 * R5.2, R5.3, R5.9, R6.1–R6.9, R7.5, R7.7, R7.8: streaming completion.
 *
 * Flow: runModel → CapturedResponse (Gemini SSE) → ChatStreamAdapter (chat.completion.chunk)
 * → StreamTransformer transform (<think> unification) → pumped manually to the real `res`.
 * The route's SSE_Heartbeat on the real `res` is the only keep-alive source that reaches the
 * client: the capture drops runModel's comments and the transformer runs with
 * `heartbeatIntervalMs: 0` (Decision 3). The transform output is pumped by hand (not `pipe`)
 * so the error event and `[DONE]` can be written after the transform's flush (Decision 4).
 */
function runStreamingCompletion(ctx) {
    const { req, res, deps, selector, meta } = ctx;
    const adapter = new openaiCompat_1.ChatStreamAdapter(meta, deps.newId);
    /** A terminal outcome was chosen; later sink callbacks are ignored. */
    let settled = false;
    /** The client closed the connection before we ended the response. */
    let clientGone = false;
    /** At least one chunk was written into the transform. */
    let emitted = false;
    /** At least one Gemini candidate event was received. */
    let sawCandidates = false;
    /** The real response returned false from write(); cleared on its `drain`. */
    let resBlocked = false;
    /** Error event to write after the transform ends (in-stream error sequence). */
    let pendingError;
    const canWrite = () => !clientGone && !responseClosed(res);
    const ensureHeaders = () => {
        // SSE_Heartbeat may already have committed the headers on its first tick.
        if (!res.headersSent)
            res.writeHead(200, SSE_HEADERS);
    };
    // R6.1: heartbeat on the real response before any upstream byte.
    const heartbeat = deps.startHeartbeat(res);
    // R6.3, Decision 3: the transformer's internal heartbeat is disabled.
    const transform = deps
        .createTransformer({ headers: req.headers, model: selector, heartbeatIntervalMs: 0 })
        .createTransformStream();
    const capture = new capturedResponse_1.CapturedResponse({
        onCandidateEvent: (event) => guarded(() => onCandidate(event)),
        onStreamError: (message, status) => guarded(() => onError(message, status)),
        onEnd: (summary) => guarded(() => onEnd(summary)),
    }, 
    // Back-pressure: the capture reports "need drain" while the client socket or the
    // transform buffer is full, so runCustomModelRequest's waitForDrain() throttles upstream.
    { needDrain: () => resBlocked || transform.writableNeedDrain });
    const onResDrain = () => {
        resBlocked = false;
        if (!transform.destroyed)
            transform.resume();
        capture.notifyDrain();
    };
    // Pump transform output to the client.
    transform.on('data', (chunk) => {
        if (!canWrite())
            return;
        ensureHeaders();
        if (!res.write(chunk)) {
            resBlocked = true;
            transform.pause();
            res.once('drain', onResDrain);
        }
    });
    transform.on('drain', () => {
        if (!resBlocked)
            capture.notifyDrain();
    });
    transform.on('end', () => {
        if (!canWrite())
            return;
        ensureHeaders();
        if (pendingError !== undefined) {
            // R7.7: (closing </think> chunk already flushed by the transform) → error → [DONE] → end.
            res.write(sseData(pendingError));
            res.write(sseData('[DONE]'));
        }
        res.end();
    });
    transform.on('error', (error) => {
        // The transform cannot be used any more: report directly on the response.
        electron_log_1.default.error('[Proxy] OpenAI stream transform failed:', error instanceof Error ? error.message : String(error));
        settled = true;
        heartbeat.stop();
        capture.destroy();
        if (!canWrite())
            return;
        if (!res.headersSent) {
            sendUnexpectedError(res);
            return;
        }
        res.write(sseData((0, openaiCompat_1.openAIError)(UNEXPECTED_ERROR_MESSAGE, 'api_error', null)));
        res.write(sseData('[DONE]'));
        res.end();
    });
    // R7.8: client disconnect stops the heartbeat, drops the transform and aborts upstream.
    res.once('close', () => {
        if (res.writableFinished)
            return; // normal end
        clientGone = true;
        settled = true;
        heartbeat.stop();
        if (!transform.destroyed)
            transform.destroy();
        capture.destroy();
    });
    function writeToTransform(text) {
        if (transform.destroyed || transform.writableEnded)
            return;
        transform.write(text);
    }
    function onCandidate(event) {
        if (settled)
            return;
        sawCandidates = true;
        const chunks = adapter.push(event);
        if (chunks.length === 0)
            return;
        // R6.2: every chunk from push() carries content, reasoning or tool calls.
        heartbeat.stop();
        emitted = true;
        for (const chunk of chunks)
            writeToTransform(sseData(chunk));
    }
    /** R7.5–R7.7: chooses HTTP error JSON or the in-stream error sequence. */
    function fail(status, body) {
        if (settled)
            return;
        settled = true;
        heartbeat.stop();
        if (clientGone)
            return;
        if (!emitted && !res.headersSent) {
            // Pre-output, headers unsent: keep the HTTP status (R7.5, R7.6).
            if (!transform.destroyed)
                transform.destroy();
            sendJsonIfOpen(res, status, body);
            return;
        }
        // After output or after the heartbeat committed headers: the transform flush closes an
        // open <think>, then the `end` handler writes the error and [DONE] (R6.5, R7.7).
        pendingError = body;
        if (!transform.destroyed && !transform.writableEnded)
            transform.end();
    }
    function onError(message, status) {
        const mapped = streamErrorBody(message, status);
        fail(mapped.status, mapped.body);
    }
    function succeed() {
        if (settled)
            return;
        settled = true;
        heartbeat.stop();
        if (clientGone)
            return;
        // R5.3: one final chunk with a non-null finish_reason (closes an open <think>, R6.8),
        // then exactly one [DONE]; `res` ends after the transform ends.
        writeToTransform(sseData(adapter.finish()));
        writeToTransform(sseData('[DONE]'));
        if (!transform.destroyed && !transform.writableEnded)
            transform.end();
    }
    function onEnd(summary) {
        if (settled)
            return;
        if (summary.statusCode >= 400) {
            const mapped = (0, openaiCompat_1.upstreamErrorBody)(summary.statusCode, summary.body ?? '');
            fail(mapped.status, mapped.body);
            return;
        }
        // Defensive: a non-SSE Gemini JSON body on a streaming request.
        if (!sawCandidates && summary.body !== undefined && summary.body.trim() !== '') {
            const gemini = parseGeminiBody(summary.body);
            if (gemini && Array.isArray(gemini.candidates))
                onCandidate(gemini);
        }
        if (!sawCandidates) {
            fail(502, (0, openaiCompat_1.openAIError)('The upstream request ended without a response.', 'api_error', null));
            return;
        }
        succeed();
    }
    function unexpected(error) {
        if (settled || clientGone)
            return;
        electron_log_1.default.error('[Proxy] OpenAI chat completion failed:', error instanceof Error ? error.message : String(error));
        fail(500, (0, openaiCompat_1.openAIError)(UNEXPECTED_ERROR_MESSAGE, 'api_error', null));
    }
    // Sink callbacks run synchronously inside runModel's writes, so they must never throw.
    function guarded(fn) {
        try {
            fn();
        }
        catch (error) {
            unexpected(error);
        }
    }
    startRunModel(ctx, capture, true, unexpected, () => fail(502, (0, openaiCompat_1.openAIError)('The upstream request ended without a response.', 'api_error', null)));
}
//# sourceMappingURL=openaiRoutes.js.map