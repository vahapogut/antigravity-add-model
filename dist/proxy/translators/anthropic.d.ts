/**
 * Anthropic provider translator.
 * Handles Gemini ↔ Anthropic request/response mapping and streaming SSE events.
 */
interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
}
interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: GeminiParameters;
}
interface GeminiParameters {
    type: string;
    properties?: Record<string, unknown>;
}
interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
interface GeminiContent {
    role?: string;
    parts?: GeminiPart[];
}
interface GeminiPart {
    text?: string;
    thought?: boolean;
    functionCall?: GeminiFunctionCall;
    functionResponse?: GeminiFunctionResponse;
}
interface GeminiFunctionCall {
    name: string;
    args: Record<string, unknown>;
    id?: string;
}
interface GeminiFunctionResponse {
    name: string;
    response: unknown;
    id?: string;
}
interface GeminiRequestBody {
    systemInstruction?: {
        parts: GeminiPart[];
    };
    contents?: GeminiContent[];
    tools?: GeminiTool[];
    generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
    };
}
interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
}
type AnthropicMessageRole = 'user' | 'assistant';
interface AnthropicMessage {
    role: AnthropicMessageRole;
    content: string | AnthropicContentBlock[];
}
interface AnthropicRequestBody {
    model: string;
    messages: AnthropicMessage[];
    system?: string;
    max_tokens: number;
    temperature?: number;
    tools?: AnthropicTool[];
}
interface AnthropicResponse {
    content?: AnthropicContentBlock[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
    stop_reason?: string;
    type?: string;
    message?: {
        id: string;
    };
    index?: number;
    content_block?: AnthropicContentBlock;
    delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string;
    };
}
interface GeminiGenerateContentResponse {
    candidates: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
}
interface GeminiCandidate {
    content: {
        parts: GeminiPart[];
        role: string;
    };
    finishReason: string;
    index: number;
}
interface GeminiUsageMetadata {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
}
declare function mapGeminiToolsToAnthropic(geminiTools: GeminiTool[]): AnthropicTool[];
export declare function mapGeminiToAnthropic(geminiBody: GeminiRequestBody, modelName: string): AnthropicRequestBody;
export declare function mapAnthropicToGemini(anthRes: AnthropicResponse, modelName: string): GeminiGenerateContentResponse;
export declare function mapAnthropicChunkToGemini(chunk: AnthropicResponse, modelName: string): GeminiCandidate | null;
export { mapGeminiToolsToAnthropic };
//# sourceMappingURL=anthropic.d.ts.map