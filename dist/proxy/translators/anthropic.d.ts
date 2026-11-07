import { ImageSource } from './images';
import { ToolSchemas } from './utils';
interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
}
interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: GeminiParameters;
    parametersJsonSchema?: Record<string, unknown>;
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
    fileData?: {
        mimeType?: string;
        fileUri: string;
    };
    inlineData?: {
        mimeType: string;
        data: string;
    };
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
    /** Media produced by the tool; the language server nests images here. */
    parts?: GeminiPart[];
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
    type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    source?: ImageSource;
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
export declare function mapGeminiToAnthropic(geminiBody: GeminiRequestBody, modelName: string, stateKey?: string): AnthropicRequestBody;
export declare function mapAnthropicToGemini(anthRes: AnthropicResponse, modelName: string, toolSchemas?: ToolSchemas): GeminiGenerateContentResponse;
export declare function mapAnthropicChunkToGemini(chunk: AnthropicResponse, modelName: string, streamKey?: string, toolSchemas?: ToolSchemas): GeminiCandidate | null;
export { mapGeminiToolsToAnthropic };
//# sourceMappingURL=anthropic.d.ts.map