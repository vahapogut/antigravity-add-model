import crypto from 'node:crypto';

export const OPENCODE_CORE_TOOL_NAMES = ['shell', 'edit', 'glob', 'grep', 'read'] as const;

export const OPENCODE_CORE_TOOLS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  edit: {
    description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
    parameters: {
      additionalProperties: false,
      properties: {
        newString: {
          description: "Text to replace oldString with (must differ from oldString)",
          type: "string",
        },
        oldString: {
          description: "Exact text to find and replace",
          type: "string",
        },
        path: {
          description: "File to edit",
          type: "string",
        },
        replaceAll: {
          description: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
          type: "boolean",
        },
      },
      required: ["path", "oldString", "newString"],
      type: "object",
    },
  },
  glob: {
    description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
    parameters: {
      additionalProperties: false,
      properties: {
        hidden: {
          description: "Include hidden files and directories (default: false).",
          type: "boolean",
        },
        limit: {
          description: "Maximum number of matching files to return (default: 100)",
          exclusiveMinimum: 0,
          type: "integer",
        },
        path: {
          description: "Directory to search. Defaults to the current working directory.",
          type: "string",
        },
        pattern: {
          description: "Glob pattern to match files against",
          type: "string",
        },
      },
      required: ["pattern"],
      type: "object",
    },
  },
  grep: {
    description: "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
    parameters: {
      additionalProperties: false,
      properties: {
        caseSensitive: {
          description: "Use case-sensitive matching (default: true).",
          type: "boolean",
        },
        include: {
          description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
          type: "string",
        },
        limit: {
          description: "Maximum number of matching lines to return (default: 100)",
          exclusiveMinimum: 0,
          type: "integer",
        },
        literal: {
          description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
          type: "boolean",
        },
        path: {
          description: "File or directory to search. Defaults to the current working directory.",
          type: "string",
        },
        pattern: {
          description: "Regular expression or literal text to match in file contents.",
          minLength: 1,
          type: "string",
        },
      },
      required: ["pattern"],
      type: "object",
    },
  },
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      additionalProperties: false,
      properties: {
        limit: {
          description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
          minimum: 0,
          type: "integer",
        },
        offset: {
          description: "The line or directory entry to start reading from (1-based)",
          minimum: 0,
          type: "integer",
        },
        path: {
          description: "File or directory to read",
          type: "string",
        },
      },
      required: ["path"],
      type: "object",
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      additionalProperties: false,
      properties: {
        background: {
          description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
          type: "boolean",
        },
        command: {
          description: "Shell command string to execute",
          type: "string",
        },
        timeout: {
          description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
          minimum: 0,
          type: "integer",
        },
        workdir: {
          description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
          type: "string",
        },
      },
      required: ["command"],
      type: "object",
    },
  },
};

export const OPENCODE_KNOWN_FREE_MODELS = new Set([
  'big-pickle',
  'cat-jam-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'north-mini-code-free',
  'hy3-free',
  'ling-3.1-flash-free',
  'space-bunny-free',
  'jev-1.13-free',
  'step-5-preview-free',
  'longcat-2.5-preview-free',
  'deepseek-v4-flash-free',
]);

/**
 * Checks whether a model is eligible for OpenCode free / keyless tier.
 */
export function isOpencodeFreeModel(modelName?: string): boolean {
  if (!modelName) return false;
  const name = modelName.trim().toLowerCase();
  return name.endsWith('-free') || OPENCODE_KNOWN_FREE_MODELS.has(name);
}

/**
 * Checks whether the provider is an OpenCode provider.
 */
export function isOpencodeProvider(provider?: string): boolean {
  return ['opencode', 'zen', 'opencode-go'].includes(String(provider || '').toLowerCase());
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function descendingTimePart(hash: Buffer): string {
  const b0 = BigInt(hash[0]);
  const b1 = BigInt(hash[1]);
  const b2 = BigInt(hash[2]);
  const b3 = BigInt(hash[3]);
  const b4 = BigInt(hash[4]);
  let current = ((b0 << 28n) | (b1 << 20n) | (b2 << 12n) | (b3 << 4n) | (b4 >> 4n)) << 12n;
  current |= 1n;
  const inverted = (~current) & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, '0');
}

function base62Fixed(bigintVal: bigint, width: number): string {
  let val = bigintVal;
  const base = 62n;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    const rem = val % base;
    val = val / base;
    out[i] = BASE62_ALPHABET[Number(rem)];
  }
  return out.join('');
}

/**
 * Generates an OpenCode session ID matching the official Identifier.descending() layout:
 * `ses_` + 12 lowercase hex characters (inverted timestamp + counter) + 14 Base62 characters.
 */
export function canonicalSessionID(signal?: string): string {
  const seed = signal || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sum = crypto.createHash('sha256').update(`ses\0${seed}`).digest();
  const timePart = descendingTimePart(sum.subarray(0, 6));
  const bigIntVal = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`);
  const randomPart = base62Fixed(bigIntVal, 14);
  return `ses_${timePart}${randomPart}`;
}

/**
 * Generates a bare 40-character lowercase hex project ID matching what official OpenCode sends.
 */
export function clientProjectID(project?: string): string {
  const sum = crypto.createHash('sha256').update(`opencode-project\0${project || 'global'}`).digest();
  return sum.subarray(0, 20).toString('hex');
}

/**
 * Official client User-Agent required by the OpenCode free tier gate.
 */
export const OPENCODE_USER_AGENT = 'opencode/latest/2.0.29/cli';

/**
 * Builds all required OpenCode client fingerprint headers for free/paid requests.
 */
export function buildOpencodeHeaders(apiKey?: string, sessionSeed?: string): Record<string, string> {
  const sessionId = canonicalSessionID(sessionSeed);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': OPENCODE_USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-project': clientProjectID(sessionSeed),
  };

  if (apiKey && apiKey !== 'none') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = 'Bearer public';
  }

  return headers;
}

/**
 * Normalizes an OpenCode endpoint. Keyless/free-tier inference uses `https://opencode.ai/inference`.
 */
export function normalizeOpencodeEndpoint(apiUrl: string, modelName?: string, isResponsesFormat = false): string {
  const url = new URL(apiUrl);
  if (url.origin === 'https://opencode.ai') {
    const isFree = isOpencodeFreeModel(modelName);
    if (isFree) {
      if (isResponsesFormat) {
        return 'https://opencode.ai/inference/v1/responses';
      }
      return 'https://opencode.ai/inference/v1/chat/completions';
    }
  }
  return apiUrl;
}

/**
 * Injects genuine core agent tools into the request body as enforced by OpenCode's free tier.
 */
export function prepareOpencodeFreeBody(
  body: Record<string, any>,
  isResponsesFormat = false,
): Record<string, any> {
  const payload: Record<string, any> = { ...body, stream: true };

  if (!isResponsesFormat) {
    payload.stream_options = { include_usage: true, ...(payload.stream_options || {}) };
  }

  const existingTools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const hadClientTools = existingTools.length > 0;
  const presentNames = new Set<string>();

  for (const tool of existingTools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = typeof tool.name === 'string' ? tool.name : tool.function?.name;
    if (typeof name === 'string') presentNames.add(name);
  }

  const toolsMap = OPENCODE_CORE_TOOLS;

  for (const name of OPENCODE_CORE_TOOL_NAMES) {
    if (presentNames.has(name)) continue;
    const def = toolsMap[name];
    if (!def) continue;

    if (isResponsesFormat) {
      existingTools.push({
        type: 'function',
        name,
        description: def.description,
        parameters: def.parameters,
      });
    } else {
      existingTools.push({
        type: 'function',
        function: {
          name,
          description: def.description,
          parameters: def.parameters,
        },
      });
    }
  }

  payload.tools = existingTools;

  if (!payload.tool_choice && !hadClientTools) {
    payload.tool_choice = isResponsesFormat ? 'auto' : 'none';
  }

  return payload;
}

/**
 * Reconstructs a full JSON chat completion response from forced SSE event stream data.
 */
export function parseSSEToOpenAIResponse(rawSSE: string, fallbackModel?: string): Record<string, any> | null {
  const lines = String(rawSSE || '').split('\n');
  const chunks: any[] = [];
  let sawChoices = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed?.choices)) {
        sawChoices = true;
      }
      chunks.push(parsed);
    } catch {
      // Ignore malformed SSE lines
    }
  }

  if (chunks.length === 0 || !sawChoices) return null;

  const first = chunks[0];
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCallsMap = new Map<number | string, { id?: string; type: string; function: { name: string; arguments: string } }>();
  let finishReason = 'stop';
  let usage: any = null;

  for (const chunk of chunks) {
    if (chunk?.usage) {
      usage = chunk.usage;
    }
    const choice = chunk?.choices?.[0];
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice?.delta || {};

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      contentParts.push(delta.content);
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      reasoningParts.push(delta.reasoning_content);
    } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
      reasoningParts.push(delta.reasoning);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? tc.id ?? 0;
        const existing = toolCallsMap.get(key);
        const argsDelta = tc.function?.arguments || '';
        if (!existing) {
          toolCallsMap.set(key, {
            id: tc.id || `call_${Date.now()}_${key}`,
            type: tc.type || 'function',
            function: {
              name: tc.function?.name || '',
              arguments: argsDelta,
            },
          });
        } else {
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (argsDelta) existing.function.arguments += argsDelta;
        }
      }
    }
  }

  const content = contentParts.join('');
  const reasoning = reasoningParts.join('');

  const message: Record<string, any> = {
    role: 'assistant',
    content: content || reasoning,
  };

  if (reasoning) {
    message.reasoning_content = reasoning;
  }

  if (toolCallsMap.size > 0) {
    message.tool_calls = Array.from(toolCallsMap.values());
  }

  return {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || 'opencode-free',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
