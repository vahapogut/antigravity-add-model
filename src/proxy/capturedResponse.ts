import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
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
export const MAX_CAPTURED_BODY_BYTES = 20 * 1024 * 1024;

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
export class GeminiSseParser {
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  write(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
  }

  /** Flushes a trailing line and any pending event. */
  end(): void {
    if (this.buffer) {
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.line(line);
    }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    // `id`, `retry` and unknown fields are ignored.
  }

  private dispatch(): void {
    const event = this.eventName;
    const lines = this.dataLines;
    this.eventName = undefined;
    this.dataLines = [];
    if (lines.length === 0) return;
    this.onEvent({ event, data: lines.join('\n') });
  }
}

/** True when every line of `text` is an SSE comment (`:`-prefixed) or blank. */
export function isSseCommentOnly(text: string): boolean {
  return text.split('\n').every((line) => {
    const trimmed = line.replace(/\r$/, '');
    return trimmed === '' || trimmed.startsWith(':');
  });
}

function errorMessageOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return undefined;
}

function errorStatusOf(value: unknown): number | undefined {
  const error = value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  const code = error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown }) : undefined;
  const status = typeof code?.code === 'number' ? code.code : code?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

type WriteCallback = (error?: Error | null) => void;

export class CapturedResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = '';
  /** Becomes true only once non-comment bytes are written (design Decision 2). */
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  sendDate = false;

  private headers: Record<string, string | string[] | number> = {};
  private mode: 'sse' | 'body' | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private readonly parser: GeminiSseParser;
  private bodyChunks: string[] = [];
  private bodyBytes = 0;
  private bodyTooLarge = false;
  private sawSseData = false;

  constructor(
    private readonly sink: GeminiOutputSink,
    private readonly backpressure: { needDrain(): boolean } = { needDrain: () => false },
  ) {
    super();
    this.parser = new GeminiSseParser((event) => this.onSseEvent(event));
  }

  get writableNeedDrain(): boolean {
    return !this.writableEnded && !this.destroyed && this.backpressure.needDrain();
  }

  get writable(): boolean {
    return !this.writableEnded && !this.destroyed;
  }

  /** Call when the real response emits `drain`; releases `waitForDrain()` in `runCustomModelRequest`. */
  notifyDrain(): void {
    if (!this.destroyed && !this.writableEnded) this.emit('drain');
  }

  writeHead(
    status: number,
    statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    maybeHeaders?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
  ): this {
    // Recorded only. Committing happens on the first non-comment write, so a
    // heartbeat-only writeHead never blocks retries or fallbacks.
    if (this.headersSent) return this;
    this.statusCode = status;
    let headers = maybeHeaders;
    if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
    else headers = statusMessageOrHeaders;
    if (headers && !Array.isArray(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) this.headers[name.toLowerCase()] = value as string | string[] | number;
      }
    }
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : (value as string | number);
    return this;
  }

  getHeader(name: string): string | string[] | number | undefined {
    return this.headers[name.toLowerCase()];
  }

  getHeaders(): Record<string, string | string[] | number> {
    return { ...this.headers };
  }

  hasHeader(name: string): boolean {
    return name.toLowerCase() in this.headers;
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  flushHeaders(): void {
    // No bytes reach the client from here; the route owns the real headers.
  }

  write(
    chunk: string | Buffer | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : cb;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    if (this.writableEnded || this.destroyed) {
      if (callback) process.nextTick(callback, new Error('write after end'));
      return false;
    }
    this.accept(chunk, encoding);
    if (callback) process.nextTick(callback);
    return !this.writableNeedDrain;
  }

  end(
    chunkOrCallback?: string | Buffer | Uint8Array | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    cb?: () => void,
  ): this {
    let chunk: string | Buffer | Uint8Array | undefined;
    let callback: (() => void) | undefined;
    let encoding: BufferEncoding | undefined;
    if (typeof chunkOrCallback === 'function') callback = chunkOrCallback;
    else chunk = chunkOrCallback;
    if (typeof encodingOrCallback === 'function') callback = encodingOrCallback;
    else encoding = encodingOrCallback;
    if (cb) callback = cb;

    // `runCustomModelRequest` may call end() twice (body end, then the success end()).
    if (this.writableEnded || this.destroyed) {
      if (callback) process.nextTick(callback);
      return this;
    }
    if (chunk !== undefined && chunk !== null) this.accept(chunk, encoding);
    // Set before notifying anyone: the `close` listener in runCustomModelRequest
    // aborts the upstream request only while writableEnded is false.
    this.writableEnded = true;
    const tail = this.decoder.end();
    if (tail) this.route(tail);
    if (this.mode === 'sse') this.parser.end();
    this.sink.onEnd(this.summary());
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
    if (callback) process.nextTick(callback);
    return this;
  }

  /** Client went away: emits `close` while not ended so runCustomModelRequest aborts upstream (R7.8). */
  destroy(_error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (!this.writableEnded) this.emit('close');
    return this;
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }

  private summary(): CapturedSummary {
    return {
      statusCode: this.statusCode,
      headers: { ...this.headers },
      body: this.mode === 'sse' || this.bodyTooLarge ? undefined : this.bodyChunks.join(''),
      bodyTooLarge: this.bodyTooLarge,
      sawSseData: this.sawSseData,
    };
  }

  private accept(chunk: string | Buffer | Uint8Array, encoding?: BufferEncoding): void {
    const text =
      typeof chunk === 'string'
        ? encoding && encoding !== 'utf8' && encoding !== 'utf-8'
          ? this.decoder.write(Buffer.from(chunk, encoding))
          : chunk
        : this.decoder.write(Buffer.from(chunk));
    if (text) this.route(text);
  }

  private contentTypeIsSse(): boolean | undefined {
    const type = this.headers['content-type'];
    if (type === undefined) return undefined;
    return String(type).toLowerCase().includes('text/event-stream');
  }

  private route(text: string): void {
    if (this.mode === undefined) {
      const sseType = this.contentTypeIsSse();
      // Heartbeat comments before any real output are dropped and do not commit (R6.7).
      if (sseType !== false && isSseCommentOnly(text)) return;
      this.mode = sseType === true || (sseType === undefined && /^\s*(data|event):/.test(text)) ? 'sse' : 'body';
      this.headersSent = true;
    }
    if (this.mode === 'sse') {
      this.parser.write(text);
      return;
    }
    if (this.bodyTooLarge) return;
    this.bodyBytes += Buffer.byteLength(text, 'utf8');
    if (this.bodyBytes > MAX_CAPTURED_BODY_BYTES) {
      this.bodyTooLarge = true;
      this.bodyChunks = [];
      return;
    }
    this.bodyChunks.push(text);
  }

  private onSseEvent({ event, data }: SseEvent): void {
    if (data.trim() === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      if (event === 'error') this.sink.onStreamError(data.trim() || 'Upstream reported a stream error.');
      else this.sink.onStreamError('Upstream sent malformed SSE JSON.');
      return;
    }
    this.sawSseData = true;
    const message = errorMessageOf(parsed);
    if (event === 'error' || message !== undefined) {
      this.sink.onStreamError(message ?? 'Upstream reported a stream error.', errorStatusOf(parsed));
      return;
    }
    let payload = parsed as Record<string, unknown> | null;
    // Unwrap a Cloud Code envelope ({ response, traceId, metadata }) if present.
    if (payload && typeof payload === 'object' && !('candidates' in payload) && payload.response) {
      payload = payload.response as Record<string, unknown>;
    }
    if (payload && typeof payload === 'object' && Array.isArray(payload.candidates)) {
      this.sink.onCandidateEvent(payload as GeminiResponse);
    }
  }
}
