import type { CustomModel } from '../proxy';
import type { GeminiBody } from './requestOptions';
export type { CustomModel, GeminiBody };
export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';
export type OpenAIContentPart = {
    type: string;
    text?: string;
    [k: string]: unknown;
};
export type OpenAIContent = string | null | OpenAIContentPart[];
export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
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
    function?: {
        name: string;
        description?: string;
        parameters?: unknown;
    };
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
export interface GeminiPart {
    text?: string;
    thought?: boolean;
    functionCall?: {
        name: string;
        args?: Record<string, unknown>;
        id?: string;
    };
    functionResponse?: {
        name: string;
        id?: string;
        response: {
            content: string;
        };
    };
}
export interface GeminiCandidate {
    content?: {
        role?: string;
        parts?: GeminiPart[];
    };
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
    function: {
        name: string;
        arguments: string;
    };
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
        }
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
        }
    ];
    usage?: OpenAIUsage;
}
export interface OpenAIErrorBody {
    error: {
        message: string;
        type: string;
        code: string | null;
    };
}
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
export type SpecResolver = (modelId: string, providerUrl: string) => {
    contextWindow?: unknown;
    maxOutputTokens?: unknown;
    [k: string]: unknown;
} | undefined;
/** A client error detected before any upstream call. Carries the HTTP status to return. */
export declare class ChatRequestError extends Error {
    readonly status: 400 | 404;
    readonly code: string | null;
    constructor(message: string, status: 400 | 404, code?: string | null);
}
export declare function openAIError(message: string, type: string, code?: string | null): OpenAIErrorBody;
/**
 * Parses and structurally validates an OpenAI chat completions body.
 * Validation order (first failure wins):
 *  1. empty or non-JSON body (R7.1)
 *  2. not an object, or `model` not a non-empty trimmed string (R7.2)
 *  3. `messages` not a non-empty array of objects with a known role (R7.3)
 */
export declare function parseChatRequest(bodyStr: string): OpenAIChatRequest;
/** R4.7: only the boolean `true` streams. */
export declare function isStreamRequest(request: OpenAIChatRequest): boolean;
/**
 * Maps a validated OpenAI chat request to a Gemini request body (R4.3–R4.6, R4.8).
 * Throws ChatRequestError(400) for unparseable `function.arguments` (R7.10) and for
 * a `tool_call_id` with no earlier matching assistant tool call (R7.11).
 */
export declare function mapChatRequestToGemini(request: OpenAIChatRequest): GeminiBody;
/**
 * Builds the OpenAI `{ object: "list", data }` model list (R3.2–R3.7, R3.10).
 * Order follows `models`; each model's stripped-name entry precedes its alias; the first
 * entry for an id wins (R3.5). A throwing or empty resolver leaves the limits out (R3.7).
 */
export declare function buildOpenAIModelList(models: CustomModel[], resolveSpec: SpecResolver, nowMs: number): OpenAIModelList;
/**
 * Maps every id listed by `buildOpenAIModelList` to the Custom_Model that produced it,
 * using the same order and first-wins rule (Decision 5).
 */
export declare function buildOpenAIModelIndex(models: CustomModel[]): Map<string, CustomModel>;
/** R5.4: function calls win; then MAX_TOKENS → length, safety family → content_filter, else stop. */
export declare function mapFinishReason(geminiReason: string | undefined, hasFunctionCall: boolean): OpenAIFinishReason;
/** R5.1, R5.4, R5.7, R5.8: converts a non-streaming Gemini response body. */
export declare function geminiToChatCompletion(gemini: GeminiResponse, meta: ChunkMeta, newId: () => string): OpenAIChatCompletion;
/**
 * Converts streamed Gemini SSE events into `chat.completion.chunk` objects (R5.2–R5.8).
 * One instance per stream. `push()` returns one chunk per non-empty part, in part order, each
 * with `finish_reason: null`; `delta.role` is set on the first emitted chunk only. `finish()`
 * returns the single final chunk with an empty delta, a non-null `finish_reason`, and `usage`
 * when any event carried `usageMetadata`.
 */
export declare class ChatStreamAdapter {
    private readonly meta;
    private readonly tools;
    private lastFinishReason;
    private usage;
    private emitted;
    constructor(meta: ChunkMeta, newId: () => string);
    /** True once a chunk carrying content, reasoning or tool calls has been returned. */
    get emittedToken(): boolean;
    push(event: GeminiResponse): OpenAIChatChunk[];
    finish(): OpenAIChatChunk;
    private chunk;
}
/**
 * Picks the HTTP status, `type` and message for a pre-output upstream failure (R7.5, R7.6).
 * Statuses outside 400–599 map to 502. `code` is always null.
 */
export declare function upstreamErrorBody(status: number, rawBody: string): {
    status: number;
    body: OpenAIErrorBody;
};
//# sourceMappingURL=openaiCompat.d.ts.map