"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapturedResponse = exports.GeminiSseParser = exports.MAX_CAPTURED_BODY_BYTES = void 0;
exports.isSseCommentOnly = isSseCommentOnly;
const node_events_1 = require("node:events");
const node_string_decoder_1 = require("node:string_decoder");
/**
 * Captures the Gemini-format output that `runCustomModelRequest()` writes to its
 * `res` argument, so the OpenAI chat completions route can convert it (design
 * Decision 2). Only the `ServerResponse` surface used by `runCustomModelRequest`
 * and `startSseHeartbeat` is implemented:
 *   writeHead, write, end, headersSent, writableEnded, destroyed,
 *   writableNeedDrain, once/on/removeListener('close' | 'drain'), statusCode.
 * Header helpers (setHeader/getHeader/...) and flushHeaders are included so an
 * accidental call does not throw.
 */
/** Same cap `runCustomModelRequest` applies to non-streaming upstream bodies. */
exports.MAX_CAPTURED_BODY_BYTES = 20 * 1024 * 1024;
/**
 * Incremental SSE parser. Handles `event:` / `data:` / comment lines, CRLF line
 * endings and events split across arbitrary chunk boundaries, like the SSE
 * reader in `customRequest.ts`.
 */
class GeminiSseParser {
    constructor(onEvent) {
        this.onEvent = onEvent;
        this.buffer = '';
        this.dataLines = [];
    }
    write(text) {
        this.buffer += text;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).replace(/\r$/, '');
            this.buffer = this.buffer.slice(index + 1);
            this.line(line);
        }
    }
    /** Flushes a trailing line and any pending event. */
    end() {
        if (this.buffer) {
            const line = this.buffer.replace(/\r$/, '');
            this.buffer = '';
            this.line(line);
        }
        this.dispatch();
    }
    line(line) {
        if (line === '') {
            this.dispatch();
            return;
        }
        if (line.startsWith(':'))
            return; // comment (keep-alive)
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data')
            this.dataLines.push(value);
        else if (field === 'event')
            this.eventName = value;
        // `id`, `retry` and unknown fields are ignored.
    }
    dispatch() {
        const event = this.eventName;
        const lines = this.dataLines;
        this.eventName = undefined;
        this.dataLines = [];
        if (lines.length === 0)
            return;
        this.onEvent({ event, data: lines.join('\n') });
    }
}
exports.GeminiSseParser = GeminiSseParser;
/** True when every line of `text` is an SSE comment (`:`-prefixed) or blank. */
function isSseCommentOnly(text) {
    return text.split('\n').every((line) => {
        const trimmed = line.replace(/\r$/, '');
        return trimmed === '' || trimmed.startsWith(':');
    });
}
function errorMessageOf(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const error = value.error;
    if (typeof error === 'string' && error)
        return error;
    if (error && typeof error === 'object') {
        const message = error.message;
        if (typeof message === 'string' && message)
            return message;
    }
    return undefined;
}
function errorStatusOf(value) {
    const error = value && typeof value === 'object' ? value.error : undefined;
    const code = error && typeof error === 'object' ? error : undefined;
    const status = typeof code?.code === 'number' ? code.code : code?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}
class CapturedResponse extends node_events_1.EventEmitter {
    constructor(sink, backpressure = { needDrain: () => false }) {
        super();
        this.sink = sink;
        this.backpressure = backpressure;
        this.statusCode = 200;
        this.statusMessage = '';
        /** Becomes true only once non-comment bytes are written (design Decision 2). */
        this.headersSent = false;
        this.writableEnded = false;
        this.writableFinished = false;
        this.destroyed = false;
        this.sendDate = false;
        this.headers = {};
        this.decoder = new node_string_decoder_1.StringDecoder('utf8');
        this.bodyChunks = [];
        this.bodyBytes = 0;
        this.bodyTooLarge = false;
        this.sawSseData = false;
        this.parser = new GeminiSseParser((event) => this.onSseEvent(event));
    }
    get writableNeedDrain() {
        return !this.writableEnded && !this.destroyed && this.backpressure.needDrain();
    }
    get writable() {
        return !this.writableEnded && !this.destroyed;
    }
    /** Call when the real response emits `drain`; releases `waitForDrain()` in `runCustomModelRequest`. */
    notifyDrain() {
        if (!this.destroyed && !this.writableEnded)
            this.emit('drain');
    }
    writeHead(status, statusMessageOrHeaders, maybeHeaders) {
        // Recorded only. Committing happens on the first non-comment write, so a
        // heartbeat-only writeHead never blocks retries or fallbacks.
        if (this.headersSent)
            return this;
        this.statusCode = status;
        let headers = maybeHeaders;
        if (typeof statusMessageOrHeaders === 'string')
            this.statusMessage = statusMessageOrHeaders;
        else
            headers = statusMessageOrHeaders;
        if (headers && !Array.isArray(headers)) {
            for (const [name, value] of Object.entries(headers)) {
                if (value !== undefined)
                    this.headers[name.toLowerCase()] = value;
            }
        }
        return this;
    }
    setHeader(name, value) {
        this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : value;
        return this;
    }
    getHeader(name) {
        return this.headers[name.toLowerCase()];
    }
    getHeaders() {
        return { ...this.headers };
    }
    hasHeader(name) {
        return name.toLowerCase() in this.headers;
    }
    removeHeader(name) {
        delete this.headers[name.toLowerCase()];
    }
    flushHeaders() {
        // No bytes reach the client from here; the route owns the real headers.
    }
    write(chunk, encodingOrCallback, cb) {
        const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : cb;
        const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
        if (this.writableEnded || this.destroyed) {
            if (callback)
                process.nextTick(callback, new Error('write after end'));
            return false;
        }
        this.accept(chunk, encoding);
        if (callback)
            process.nextTick(callback);
        return !this.writableNeedDrain;
    }
    end(chunkOrCallback, encodingOrCallback, cb) {
        let chunk;
        let callback;
        let encoding;
        if (typeof chunkOrCallback === 'function')
            callback = chunkOrCallback;
        else
            chunk = chunkOrCallback;
        if (typeof encodingOrCallback === 'function')
            callback = encodingOrCallback;
        else
            encoding = encodingOrCallback;
        if (cb)
            callback = cb;
        // `runCustomModelRequest` may call end() twice (body end, then the success end()).
        if (this.writableEnded || this.destroyed) {
            if (callback)
                process.nextTick(callback);
            return this;
        }
        if (chunk !== undefined && chunk !== null)
            this.accept(chunk, encoding);
        // Set before notifying anyone: the `close` listener in runCustomModelRequest
        // aborts the upstream request only while writableEnded is false.
        this.writableEnded = true;
        const tail = this.decoder.end();
        if (tail)
            this.route(tail);
        if (this.mode === 'sse')
            this.parser.end();
        this.sink.onEnd(this.summary());
        this.writableFinished = true;
        this.emit('finish');
        this.emit('close');
        if (callback)
            process.nextTick(callback);
        return this;
    }
    /** Client went away: emits `close` while not ended so runCustomModelRequest aborts upstream (R7.8). */
    destroy(_error) {
        if (this.destroyed)
            return this;
        this.destroyed = true;
        if (!this.writableEnded)
            this.emit('close');
        return this;
    }
    asServerResponse() {
        return this;
    }
    summary() {
        return {
            statusCode: this.statusCode,
            headers: { ...this.headers },
            body: this.mode === 'sse' || this.bodyTooLarge ? undefined : this.bodyChunks.join(''),
            bodyTooLarge: this.bodyTooLarge,
            sawSseData: this.sawSseData,
        };
    }
    accept(chunk, encoding) {
        const text = typeof chunk === 'string'
            ? encoding && encoding !== 'utf8' && encoding !== 'utf-8'
                ? this.decoder.write(Buffer.from(chunk, encoding))
                : chunk
            : this.decoder.write(Buffer.from(chunk));
        if (text)
            this.route(text);
    }
    contentTypeIsSse() {
        const type = this.headers['content-type'];
        if (type === undefined)
            return undefined;
        return String(type).toLowerCase().includes('text/event-stream');
    }
    route(text) {
        if (this.mode === undefined) {
            const sseType = this.contentTypeIsSse();
            // Heartbeat comments before any real output are dropped and do not commit (R6.7).
            if (sseType !== false && isSseCommentOnly(text))
                return;
            this.mode = sseType === true || (sseType === undefined && /^\s*(data|event):/.test(text)) ? 'sse' : 'body';
            this.headersSent = true;
        }
        if (this.mode === 'sse') {
            this.parser.write(text);
            return;
        }
        if (this.bodyTooLarge)
            return;
        this.bodyBytes += Buffer.byteLength(text, 'utf8');
        if (this.bodyBytes > exports.MAX_CAPTURED_BODY_BYTES) {
            this.bodyTooLarge = true;
            this.bodyChunks = [];
            return;
        }
        this.bodyChunks.push(text);
    }
    onSseEvent({ event, data }) {
        if (data.trim() === '[DONE]')
            return;
        let parsed;
        try {
            parsed = JSON.parse(data);
        }
        catch {
            if (event === 'error')
                this.sink.onStreamError(data.trim() || 'Upstream reported a stream error.');
            else
                this.sink.onStreamError('Upstream sent malformed SSE JSON.');
            return;
        }
        this.sawSseData = true;
        const message = errorMessageOf(parsed);
        if (event === 'error' || message !== undefined) {
            this.sink.onStreamError(message ?? 'Upstream reported a stream error.', errorStatusOf(parsed));
            return;
        }
        let payload = parsed;
        // Unwrap a Cloud Code envelope ({ response, traceId, metadata }) if present.
        if (payload && typeof payload === 'object' && !('candidates' in payload) && payload.response) {
            payload = payload.response;
        }
        if (payload && typeof payload === 'object' && Array.isArray(payload.candidates)) {
            this.sink.onCandidateEvent(payload);
        }
    }
}
exports.CapturedResponse = CapturedResponse;
//# sourceMappingURL=capturedResponse.js.map