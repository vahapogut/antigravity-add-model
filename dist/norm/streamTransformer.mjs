import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3000;
export const KEEP_ALIVE_COMMENT = ': keep-alive\n\n';

/**
 * Detects whether a request comes from Antigravity's native chat / IDE or expects
 * `<think>...</think>` reasoning unification in `delta.content`.
 */
function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function isAntigravityChatClient(headers = {}) {
  if (!headers || typeof headers !== 'object') return true;
  // Explicit opt-out wins over any user-agent or client header (header name is
  // case-insensitive, value must be exactly 'true').
  if (headerValue(headers, 'x-omninorm-raw-reasoning') === 'true') {
    return false;
  }
  const ua = String(headers['user-agent'] || headers['User-Agent'] || '').toLowerCase();
  const clientHeader = String(
    headers['x-antigravity-client'] ||
      headers['x-client-name'] ||
      headers['x-ide-client'] ||
      '',
  ).toLowerCase();
  if (
    ua.includes('antigravity') ||
    ua.includes('jetski') ||
    ua.includes('electron') ||
    ua.includes('vscode') ||
    clientHeader.includes('antigravity')
  ) {
    return true;
  }
  // Default to unifying reasoning into <think>
  return true;
}

export class StreamTransformer {
  constructor(options = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.unifyReasoning =
      options.unifyReasoning !== undefined
        ? Boolean(options.unifyReasoning)
        : isAntigravityChatClient(options.headers);
    this.inThinkBlock = false;
    this.receivedFirstToken = false;
    this.lastChunkMeta = {
      id: 'chatcmpl-omninorm',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: options.model || 'custom-model',
    };
  }

  /**
   * Transforms a single parsed OpenAI SSE chunk object.
   * Ensures well-formed delta structures, prevents null/empty delta crashes,
   * and unifies `delta.reasoning_content` / `delta.reasoning` into `<think>...</think>` inside `delta.content`.
   * @param {Record<string, any>} chunk
   * @returns {Record<string, any> | null} Transformed chunk, or null if chunk should be suppressed
   */
  transformChunkObject(chunk) {
    if (!chunk || typeof chunk !== 'object') return null;

    if (chunk.id) this.lastChunkMeta.id = chunk.id;
    if (chunk.model) this.lastChunkMeta.model = chunk.model;
    if (chunk.created) this.lastChunkMeta.created = chunk.created;

    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
      // Usage-only or metadata chunk
      return chunk;
    }

    const rawChoice = chunk.choices[0];
    if (!rawChoice || typeof rawChoice !== 'object') {
      return null;
    }

    const choice = { ...rawChoice };
    const delta =
      choice.delta && typeof choice.delta === 'object' ? { ...choice.delta } : {};
    choice.delta = delta;

    const reasoningText =
      typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' && delta.reasoning.length > 0
          ? delta.reasoning
          : '';
    const contentText = typeof delta.content === 'string' ? delta.content : '';
    const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    const hasFinishReason =
      choice.finish_reason !== undefined && choice.finish_reason !== null;

    if (reasoningText || contentText || hasToolCalls) {
      this.receivedFirstToken = true;
    }

    if (this.unifyReasoning) {
      if (reasoningText) {
        delete delta.reasoning_content;
        delete delta.reasoning;
        let combined = '';
        if (!this.inThinkBlock) {
          this.inThinkBlock = true;
          combined += `<think>${reasoningText}`;
        } else {
          combined += reasoningText;
        }
        if (contentText) {
          this.inThinkBlock = false;
          combined += `</think>\n\n${contentText}`;
        }
        delta.content = combined;
      } else if (contentText) {
        if (this.inThinkBlock) {
          this.inThinkBlock = false;
          delta.content = `</think>\n\n${contentText}`;
        }
      } else if ((hasToolCalls || hasFinishReason) && this.inThinkBlock) {
        this.inThinkBlock = false;
        delta.content = '</think>\n\n';
      }
    }

    // Sanitize null content when no tool calls or finish_reason are present to avoid client crashes
    if (delta.content === null && !hasToolCalls && !hasFinishReason) {
      delta.content = '';
    }

    // Skip completely empty non-terminal delta chunks that carry no role, content, reasoning, tools, or finish_reason
    const hasMeaningfulDelta =
      (typeof delta.content === 'string' && delta.content.length > 0) ||
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
      (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) ||
      typeof delta.role === 'string' ||
      hasToolCalls ||
      hasFinishReason ||
      Boolean(chunk.usage);

    if (!hasMeaningfulDelta) {
      return null;
    }

    const clonedChoices = [...chunk.choices];
    clonedChoices[0] = choice;
    return {
      ...chunk,
      id: chunk.id || this.lastChunkMeta.id,
      object: chunk.object || 'chat.completion.chunk',
      created: chunk.created || this.lastChunkMeta.created,
      model: chunk.model || this.lastChunkMeta.model,
      choices: clonedChoices,
    };
  }

  /**
   * If the stream ends while a `<think>` block is still open, emits a synthetic closing chunk.
   */
  flushClosingChunk() {
    if (!this.inThinkBlock) return null;
    this.inThinkBlock = false;
    return {
      id: this.lastChunkMeta.id,
      object: 'chat.completion.chunk',
      created: this.lastChunkMeta.created,
      model: this.lastChunkMeta.model,
      choices: [
        {
          index: 0,
          delta: { content: '</think>\n\n' },
          finish_reason: null,
        },
      ],
    };
  }

  /**
   * Creates a Node.js Transform stream that wraps an upstream SSE stream:
   * - Emits `: keep-alive\n\n` every `heartbeatIntervalMs` (default 3000ms) until the first token arrives
   * - Parses `data: ...` SSE lines, applies `transformChunkObject`, and emits well-formed SSE events
   */
  createTransformStream() {
    const self = this;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let dataLines = [];
    let heartbeatTimer = null;

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const flushEvent = (stream) => {
      if (dataLines.length === 0) return;
      const payload = dataLines.join('\n').trim();
      dataLines = [];
      if (!payload) return;

      if (payload === '[DONE]') {
        stopHeartbeat();
        const closing = self.flushClosingChunk();
        if (closing) {
          stream.push(`data: ${JSON.stringify(closing)}\n\n`);
        }
        stream.push('data: [DONE]\n\n');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Ignore malformed non-JSON fragments so client stream doesn't crash
        return;
      }

      const transformed = self.transformChunkObject(parsed);
      if (self.receivedFirstToken) {
        stopHeartbeat();
      }
      if (transformed) {
        stream.push(`data: ${JSON.stringify(transformed)}\n\n`);
      }
    };

    const processBuffer = (stream) => {
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        if (line === '') {
          flushEvent(stream);
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith(':')) {
          // Pass through upstream SSE comments
          stream.push(`${line}\n\n`);
        }
      }
    };

    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          processBuffer(this);
          callback();
        } catch (err) {
          callback(err);
        }
      },
      flush(callback) {
        stopHeartbeat();
        try {
          buffer += decoder.end();
          if (buffer) buffer += '\n';
          processBuffer(this);
          flushEvent(this);
          const closing = self.flushClosingChunk();
          if (closing) {
            this.push(`data: ${JSON.stringify(closing)}\n\n`);
          }
          callback();
        } catch (err) {
          callback(err);
        }
      },
      destroy(err, callback) {
        stopHeartbeat();
        callback(err);
      },
    });

    if (this.heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (self.receivedFirstToken || transform.destroyed || transform.writableEnded) {
          stopHeartbeat();
          return;
        }
        transform.push(KEEP_ALIVE_COMMENT);
      }, this.heartbeatIntervalMs);
      if (typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }
    }

    return transform;
  }
}

/**
 * Attaches an anti-stall SSE heartbeat timer to an `http.ServerResponse`
 * that emits `: keep-alive\n\n` every `intervalMs` until `stop()` is called
 * (e.g. when the first token arrives or the response closes).
 */
export function startSseHeartbeat(res, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
      }
      res.write(KEEP_ALIVE_COMMENT);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  const stop = () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
  };

  res.once('close', stop);
  return { stop };
}
