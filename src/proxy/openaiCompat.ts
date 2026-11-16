// OpenAI-compatible request parsing, mapping and response helpers for the
// /v1/models and /v1/chat/completions routes (OmniNorm integration).
//
// Only type imports from '../proxy' and './requestOptions' so this module adds
// no runtime dependency cycle with src/proxy.ts.
import type { CustomModel } from '../proxy';
import type { GeminiBody } from './requestOptions';

export type { CustomModel, GeminiBody };

// ── OpenAI request (subset accepted by the route) ──────────────────────────

export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type OpenAIContentPart = { type: string; text?: string; [k: string]: unknown };
export type OpenAIContent = string | null | OpenAIContentPart[];

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content?: OpenAIContent;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: string;
  function?: { name: string; description?: string; parameters?: unknown };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: unknown;
  tools?: OpenAITool[];
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  [k: string]: unknown;
}

// ── Gemini (as produced / consumed by runCustomModelRequest) ───────────────

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: { content: string } };
}

export interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  index?: number;
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
}

// ── OpenAI responses ───────────────────────────────────────────────────────

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ChunkMeta {
  id: string;
  created: number;
  model: string;
}

export interface OpenAIToolCallOut {
  index: number;
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: {
        role: 'assistant';
        content: string | null;
        reasoning_content?: string;
        tool_calls?: OpenAIToolCallOut[];
      };
      finish_reason: OpenAIFinishReason;
    },
  ];
  usage?: OpenAIUsage;
}

export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      delta: {
        role?: 'assistant';
        content?: string;
        reasoning_content?: string;
        tool_calls?: OpenAIToolCallOut[];
      };
      finish_reason: OpenAIFinishReason | null;
    },
  ];
  usage?: OpenAIUsage;
}

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string | null };
}

// ── Model list ─────────────────────────────────────────────────────────────

export interface OpenAIModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  context_window?: number;
  max_output_tokens?: number;
}

export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModelEntry[];
}

/**
 * Shape-compatible with `defaultCatalogResolver.resolveModelSpec(rawModelId, providerUrl)` in
 * src/norm/catalogResolver.mjs, which returns `{ contextWindow, maxOutputTokens, supportsVision,
 * supportsTools, supportsReasoning, reasoningFormat }` (limits default to 131072 / 8192).
 * The limits are typed `unknown` because callers validate them (R3.6) and fakes may return anything.
 */
export type SpecResolver = (
  modelId: string,
  providerUrl: string,
) => { contextWindow?: unknown; maxOutputTokens?: unknown; [k: string]: unknown } | undefined;

// ── Errors and validation ──────────────────────────────────────────────────

/** A client error detected before any upstream call. Carries the HTTP status to return. */
export class ChatRequestError extends Error {
  readonly status: 400 | 404;
  readonly code: string | null;

  constructor(message: string, status: 400 | 404, code: string | null = null) {
    super(message);
    this.name = 'ChatRequestError';
    this.status = status;
    this.code = code;
  }
}

export function openAIError(message: string, type: string, code: string | null = null): OpenAIErrorBody {
  return { error: { message, type, code } };
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and structurally validates an OpenAI chat completions body.
 * Validation order (first failure wins):
 *  1. empty or non-JSON body (R7.1)
 *  2. not an object, or `model` not a non-empty trimmed string (R7.2)
 *  3. `messages` not a non-empty array of objects with a known role (R7.3)
 */
export function parseChatRequest(bodyStr: string): OpenAIChatRequest {
  let parsed: unknown;
  if (typeof bodyStr !== 'string' || bodyStr.trim() === '') {
    throw new ChatRequestError('Request body is not valid JSON.', 400);
  }
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    throw new ChatRequestError('Request body is not valid JSON.', 400);
  }

  if (!isPlainObject(parsed) || typeof parsed.model !== 'string' || parsed.model.trim() === '') {
    throw new ChatRequestError('The request must include a non-empty string `model` field.', 400);
  }

  const messages = parsed.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ChatRequestError('The request must include a non-empty `messages` array.', 400);
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isPlainObject(message) || typeof message.role !== 'string' || !KNOWN_ROLES.has(message.role)) {
      throw new ChatRequestError(
        `Invalid entry at messages[${i}]: each message must be an object with a role of system, developer, user, assistant or tool.`,
        400,
      );
    }
  }

  return parsed as OpenAIChatRequest;
}

/** R4.7: only the boolean `true` streams. */
export function isStreamRequest(request: OpenAIChatRequest): boolean {
  return request.stream === true;
}

// ── Request mapping (OpenAI → Gemini) ──────────────────────────────────────

type GeminiContent = NonNullable<GeminiBody['contents']>[number];
type GeminiBodyPart = NonNullable<GeminiContent['parts']>[number];

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** Text parts of a message content, one entry per string / `type: "text"` element, in order. */
function contentTexts(content: OpenAIContent | undefined): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (isPlainObject(part) && part.type === 'text') {
      texts.push(typeof part.text === 'string' ? part.text : '');
    }
  }
  return texts;
}

function parseToolArguments(raw: unknown, callId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    if (typeof raw !== 'string') throw new Error('not a string');
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatRequestError(`Invalid tool call '${callId}': function.arguments must be a JSON-encoded object.`, 400);
  }
  if (!isPlainObject(parsed)) {
    throw new ChatRequestError(`Invalid tool call '${callId}': function.arguments must be a JSON-encoded object.`, 400);
  }
  return parsed;
}

/**
 * Maps a validated OpenAI chat request to a Gemini request body (R4.3–R4.6, R4.8).
 * Throws ChatRequestError(400) for unparseable `function.arguments` (R7.10) and for
 * a `tool_call_id` with no earlier matching assistant tool call (R7.11).
 */
export function mapChatRequestToGemini(request: OpenAIChatRequest): GeminiBody {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];
  const callNames = new Map<string, string>();

  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        systemTexts.push(contentTexts(message.content).join(''));
        break;

      case 'user': {
        const texts = contentTexts(message.content);
        const parts = texts.length > 0 ? texts.map((text) => ({ text })) : [{ text: '' }];
        contents.push({ role: 'user', parts });
        break;
      }

      case 'assistant': {
        const parts: GeminiBodyPart[] = contentTexts(message.content).map((text) => ({ text }));
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls) {
          const id = isPlainObject(call) && typeof call.id === 'string' ? call.id : '';
          const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : undefined;
          const name = fn && typeof fn.name === 'string' ? fn.name : '';
          const args = parseToolArguments(fn?.arguments, id);
          if (id) callNames.set(id, name);
          parts.push({ functionCall: { name, args, id } });
        }
        contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
        break;
      }

      case 'tool': {
        const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
        const name = id ? callNames.get(id) : undefined;
        if (name === undefined) {
          throw new ChatRequestError(
            `Tool message references tool_call_id '${id}', which matches no earlier assistant tool call.`,
            400,
          );
        }
        const content = contentTexts(message.content).join('');
        contents.push({ role: 'user', parts: [{ functionResponse: { name, id, response: { content } } }] });
        break;
      }
    }
  }

  const body: GeminiBody = { contents };

  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }

  if (Array.isArray(request.tools)) {
    const functionDeclarations: Record<string, unknown>[] = [];
    for (const tool of request.tools) {
      if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) continue;
      const fn = tool.function;
      const declaration: Record<string, unknown> = { name: fn.name };
      if (fn.description !== undefined) declaration.description = fn.description;
      if (fn.parameters !== undefined) declaration.parameters = fn.parameters;
      functionDeclarations.push(declaration);
    }
    if (functionDeclarations.length > 0) body.tools = [{ functionDeclarations }];
  }

  const generationConfig: Record<string, unknown> = {};
  const maxTokens = isPresent(request.max_completion_tokens) ? request.max_completion_tokens : request.max_tokens;
  if (isPresent(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
  if (isPresent(request.temperature)) generationConfig.temperature = request.temperature;
  if (isPresent(request.top_p)) generationConfig.topP = request.top_p;
  if (typeof request.stop === 'string') generationConfig.stopSequences = [request.stop];
  else if (Array.isArray(request.stop)) generationConfig.stopSequences = [...request.stop];
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  return body;
}

// ── Model list (GET /v1/models) ────────────────────────────────────────────

const OWNED_BY_FALLBACK = 'custom';

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** R3.3: removes exactly one leading `models/` prefix. */
function stripModelsPrefix(name: unknown): string {
  const value = typeof name === 'string' ? name : '';
  return value.startsWith('models/') ? value.slice('models/'.length) : value;
}

/**
 * The ids a Custom_Model is advertised under, in order: stripped `name` (when non-empty),
 * then `externalModelName` (when non-empty and different from the stripped name).
 */
function candidateIds(model: CustomModel): string[] {
  const stripped = stripModelsPrefix(model.name);
  const external = typeof model.externalModelName === 'string' ? model.externalModelName : '';
  const ids: string[] = [];
  if (stripped !== '') ids.push(stripped);
  if (external !== '' && external !== stripped) ids.push(external);
  return ids;
}

/**
 * Builds the OpenAI `{ object: "list", data }` model list (R3.2–R3.7, R3.10).
 * Order follows `models`; each model's stripped-name entry precedes its alias; the first
 * entry for an id wins (R3.5). A throwing or empty resolver leaves the limits out (R3.7).
 */
export function buildOpenAIModelList(models: CustomModel[], resolveSpec: SpecResolver, nowMs: number): OpenAIModelList {
  const created = Math.max(0, Math.floor(nowMs / 1000));
  const seen = new Set<string>();
  const data: OpenAIModelEntry[] = [];

  for (const model of models) {
    const ids = candidateIds(model).filter((id) => !seen.has(id));
    if (ids.length === 0) continue;

    const shared: Omit<OpenAIModelEntry, 'id'> = {
      object: 'model',
      created,
      owned_by: typeof model.provider === 'string' && model.provider !== '' ? model.provider : OWNED_BY_FALLBACK,
    };

    let spec: ReturnType<SpecResolver>;
    try {
      const lookupId = model.externalModelName || stripModelsPrefix(model.name);
      spec = resolveSpec(lookupId, typeof model.apiUrl === 'string' ? model.apiUrl : '');
    } catch {
      spec = undefined;
    }
    if (isPlainObject(spec)) {
      if (isPositiveInteger(spec.contextWindow)) shared.context_window = spec.contextWindow;
      if (isPositiveInteger(spec.maxOutputTokens)) shared.max_output_tokens = spec.maxOutputTokens;
    }

    for (const id of ids) {
      seen.add(id);
      data.push({ id, ...shared });
    }
  }

  return { object: 'list', data };
}

/**
 * Maps every id listed by `buildOpenAIModelList` to the Custom_Model that produced it,
 * using the same order and first-wins rule (Decision 5).
 */
export function buildOpenAIModelIndex(models: CustomModel[]): Map<string, CustomModel> {
  const index = new Map<string, CustomModel>();
  for (const model of models) {
    for (const id of candidateIds(model)) {
      if (!index.has(id)) index.set(id, model);
    }
  }
  return index;
}

// ── Response conversion (Gemini → OpenAI) ──────────────────────────────────
//
// Input is what runCustomModelRequest() writes with cloudEnvelope = false:
//  - streaming: one SSE `data: {"candidates":[{content:{role:'model',parts},finishReason?,index:0}]}`
//    per mapped upstream chunk, ending with a candidate carrying a finishReason (possibly with
//    `parts: []`). Streaming events carry no `usageMetadata` today, but it is read if present.
//  - non-streaming: one `{ candidates: [...], usageMetadata: { promptTokenCount,
//    candidatesTokenCount, totalTokenCount } }` JSON body.
// Thought text is a text part with `thought: true`; tool calls are `functionCall: { name, args, id? }`.

const CONTENT_FILTER_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/** R5.4: function calls win; then MAX_TOKENS → length, safety family → content_filter, else stop. */
export function mapFinishReason(geminiReason: string | undefined, hasFunctionCall: boolean): OpenAIFinishReason {
  if (hasFunctionCall) return 'tool_calls';
  if (geminiReason === 'MAX_TOKENS') return 'length';
  if (typeof geminiReason === 'string' && CONTENT_FILTER_REASONS.has(geminiReason)) return 'content_filter';
  return 'stop';
}

function usageCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** R5.7: missing (or invalid) counts become 0. */
function mapUsage(usage: GeminiUsage): OpenAIUsage {
  return {
    prompt_tokens: usageCount(usage.promptTokenCount),
    completion_tokens: usageCount(usage.candidatesTokenCount),
    total_tokens: usageCount(usage.totalTokenCount),
  };
}

function candidateParts(candidate: GeminiCandidate | undefined): GeminiPart[] {
  const parts = candidate?.content?.parts;
  return Array.isArray(parts) ? parts.filter((part): part is GeminiPart => isPlainObject(part)) : [];
}

function hasFunctionCall(part: GeminiPart): boolean {
  return isPlainObject(part.functionCall);
}

/**
 * Builds tool call entries with sequential indexes and ids that are unique within one response
 * (R5.8). Reuses `functionCall.id` when non-empty and unused, else `call_<newId()>`.
 */
class ToolCallBuilder {
  private readonly usedIds = new Set<string>();
  private nextIndex = 0;

  constructor(private readonly newId: () => string) {}

  get count(): number {
    return this.nextIndex;
  }

  build(call: NonNullable<GeminiPart['functionCall']>): OpenAIToolCallOut {
    let id = typeof call.id === 'string' && call.id !== '' && !this.usedIds.has(call.id) ? call.id : '';
    while (id === '' || this.usedIds.has(id)) id = 'call_' + this.newId();
    this.usedIds.add(id);
    let args: string;
    try {
      args = JSON.stringify(call.args ?? {}) ?? '{}';
    } catch {
      args = '{}';
    }
    return {
      index: this.nextIndex++,
      id,
      type: 'function',
      function: { name: typeof call.name === 'string' ? call.name : '', arguments: args },
    };
  }
}

/** R5.1, R5.4, R5.7, R5.8: converts a non-streaming Gemini response body. */
export function geminiToChatCompletion(
  gemini: GeminiResponse,
  meta: ChunkMeta,
  newId: () => string,
): OpenAIChatCompletion {
  const candidate = Array.isArray(gemini?.candidates) ? gemini.candidates[0] : undefined;
  const parts = candidateParts(candidate);
  const tools = new ToolCallBuilder(newId);

  let content: string | null = null;
  let reasoning: string | undefined;
  const toolCalls: OpenAIToolCallOut[] = [];

  for (const part of parts) {
    if (hasFunctionCall(part)) toolCalls.push(tools.build(part.functionCall!));
    if (typeof part.text !== 'string') continue;
    if (part.thought === true) reasoning = (reasoning ?? '') + part.text;
    else content = (content ?? '') + part.text;
  }

  const message: OpenAIChatCompletion['choices'][0]['message'] = { role: 'assistant', content };
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const completion: OpenAIChatCompletion = {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
      },
    ],
  };
  if (isPlainObject(gemini?.usageMetadata)) completion.usage = mapUsage(gemini.usageMetadata);
  return completion;
}

/**
 * Converts streamed Gemini SSE events into `chat.completion.chunk` objects (R5.2–R5.8).
 * One instance per stream. `push()` returns one chunk per non-empty part, in part order, each
 * with `finish_reason: null`; `delta.role` is set on the first emitted chunk only. `finish()`
 * returns the single final chunk with an empty delta, a non-null `finish_reason`, and `usage`
 * when any event carried `usageMetadata`.
 */
export class ChatStreamAdapter {
  private readonly tools: ToolCallBuilder;
  private lastFinishReason: string | undefined;
  private usage: GeminiUsage | undefined;
  private emitted = false;

  constructor(
    private readonly meta: ChunkMeta,
    newId: () => string,
  ) {
    this.tools = new ToolCallBuilder(newId);
  }

  /** True once a chunk carrying content, reasoning or tool calls has been returned. */
  get emittedToken(): boolean {
    return this.emitted;
  }

  push(event: GeminiResponse): OpenAIChatChunk[] {
    if (!isPlainObject(event)) return [];
    if (isPlainObject(event.usageMetadata)) this.usage = event.usageMetadata;
    const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
    if (typeof candidate?.finishReason === 'string' && candidate.finishReason !== '') {
      this.lastFinishReason = candidate.finishReason;
    }

    const chunks: OpenAIChatChunk[] = [];
    for (const part of candidateParts(candidate)) {
      const delta: OpenAIChatChunk['choices'][0]['delta'] = {};
      if (typeof part.text === 'string' && part.text !== '') {
        if (part.thought === true) delta.reasoning_content = part.text;
        else delta.content = part.text;
      }
      if (hasFunctionCall(part)) delta.tool_calls = [this.tools.build(part.functionCall!)];
      if (delta.content === undefined && delta.reasoning_content === undefined && !delta.tool_calls) continue;
      if (!this.emitted) {
        this.emitted = true;
        chunks.push(this.chunk({ role: 'assistant', ...delta }, null));
      } else {
        chunks.push(this.chunk(delta, null));
      }
    }
    return chunks;
  }

  finish(): OpenAIChatChunk {
    const final = this.chunk({}, mapFinishReason(this.lastFinishReason, this.tools.count > 0));
    if (this.usage) final.usage = mapUsage(this.usage);
    return final;
  }

  private chunk(
    delta: OpenAIChatChunk['choices'][0]['delta'],
    finishReason: OpenAIFinishReason | null,
  ): OpenAIChatChunk {
    return {
      id: this.meta.id,
      object: 'chat.completion.chunk',
      created: this.meta.created,
      model: this.meta.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}

/** Reads `error.message` (or a top-level `message`) from an upstream JSON error body. */
function readUpstreamMessage(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isPlainObject(parsed)) return '';
    const error = parsed.error;
    if (isPlainObject(error) && typeof error.message === 'string') return error.message.trim();
    if (typeof error === 'string') return error.trim();
    if (typeof parsed.message === 'string') return parsed.message.trim();
  } catch {
    // Not JSON: no readable message.
  }
  return '';
}

/**
 * Picks the HTTP status, `type` and message for a pre-output upstream failure (R7.5, R7.6).
 * Statuses outside 400–599 map to 502. `code` is always null.
 */
export function upstreamErrorBody(status: number, rawBody: string): { status: number; body: OpenAIErrorBody } {
  const inRange = Number.isInteger(status) && status >= 400 && status <= 599;
  const outStatus = inRange ? status : 502;
  const message = typeof rawBody === 'string' ? readUpstreamMessage(rawBody) : '';
  if (message === '') {
    return {
      status: outStatus,
      body: openAIError(`Upstream request failed with HTTP ${status}.`, 'api_error', null),
    };
  }
  let type = 'api_error';
  if (outStatus === 429) type = 'rate_limit_error';
  else if (outStatus >= 400 && outStatus <= 499) type = 'invalid_request_error';
  return { status: outStatus, body: openAIError(message, type, null) };
}
