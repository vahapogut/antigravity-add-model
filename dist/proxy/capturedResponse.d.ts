import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import type { GeminiResponse } from './openaiCompat';
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
export declare const MAX_CAPTURED_BODY_BYTES: number;
export interface CapturedSummary {
    /** Last status passed to `writeHead` (200 when never called). */
    statusCode: number;
    /** Headers from the last `writeHead` / `setHeader` calls, lower-cased names. */
    headers: Record<string, string | string[] | number>;
    /** Raw body text for non-SSE output; `undefined` when the output was parsed as SSE. */
    body: string | undefined;
    /** True when the non-SSE body exceeded `MAX_CAPTURED_BODY_BYTES` (body is then `undefined`). */
    bodyTooLarge: boolean;
    /** True when at least one SSE `data:` event was dispatched. */
    sawSseData: boolean;
}
export interface GeminiOutputSink {
    /** One SSE data event that carries `candidates` (cloud `response` envelopes are unwrapped). */
    onCandidateEvent(event: GeminiResponse): void;
    /** An `event: error` SSE event, a data payload with `error`, or a malformed data payload. */
    onStreamError(message: string, status?: number): void;
    /** Called once when the captured response ends normally (not after `destroy()`). */
    onEnd(capture: CapturedSummary): void;
}
export interface SseEvent {
    event: string | undefined;
    data: string;
}
/**
 * Incremental SSE parser. Handles `event:` / `data:` / comment lines, CRLF line
 * endings and events split across arbitrary chunk boundaries, like the SSE
 * reader in `customRequest.ts`.
 */
export declare class GeminiSseParser {
    private readonly onEvent;
    private buffer;
    private eventName;
    private dataLines;
    constructor(onEvent: (event: SseEvent) => void);
    write(text: string): void;
    /** Flushes a trailing line and any pending event. */
    end(): void;
    private line;
    private dispatch;
}
/** True when every line of `text` is an SSE comment (`:`-prefixed) or blank. */
export declare function isSseCommentOnly(text: string): boolean;
type WriteCallback = (error?: Error | null) => void;
export declare class CapturedResponse extends EventEmitter {
    private readonly sink;
    private readonly backpressure;
    statusCode: number;
    statusMessage: string;
    /** Becomes true only once non-comment bytes are written (design Decision 2). */
    headersSent: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    destroyed: boolean;
    sendDate: boolean;
    private headers;
    private mode;
    private readonly decoder;
    private readonly parser;
    private bodyChunks;
    private bodyBytes;
    private bodyTooLarge;
    private sawSseData;
    constructor(sink: GeminiOutputSink, backpressure?: {
        needDrain(): boolean;
    });
    get writableNeedDrain(): boolean;
    get writable(): boolean;
    /** Call when the real response emits `drain`; releases `waitForDrain()` in `runCustomModelRequest`. */
    notifyDrain(): void;
    writeHead(status: number, statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[], maybeHeaders?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[]): this;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | string[] | number | undefined;
    getHeaders(): Record<string, string | string[] | number>;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    flushHeaders(): void;
    write(chunk: string | Buffer | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, cb?: WriteCallback): boolean;
    end(chunkOrCallback?: string | Buffer | Uint8Array | (() => void), encodingOrCallback?: BufferEncoding | (() => void), cb?: () => void): this;
    /** Client went away: emits `close` while not ended so runCustomModelRequest aborts upstream (R7.8). */
    destroy(_error?: Error): this;
    asServerResponse(): http.ServerResponse;
    private summary;
    private accept;
    private contentTypeIsSse;
    private route;
    private onSseEvent;
}
export {};
//# sourceMappingURL=capturedResponse.d.ts.map