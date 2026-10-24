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
interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
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
type OpenAIContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: {
        url: string;
    };
};
interface OpenAIMessage {
    role: string;
    content: string | OpenAIContentPart[] | null;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}
interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    temperature?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    tools?: OpenAITool[];
    stream?: boolean;
}
interface OpenAIResponse {
    choices?: OpenAIChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
interface OpenAIChoice {
    message?: {
        content: string;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
    delta?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: OpenAIToolCallDelta[];
    };
}
interface OpenAIToolCallDelta {
    index?: number;
    id?: string;
    function?: {
        name?: string;
        arguments?: string;
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
declare function mapGeminiToolsToOpenAI(geminiTools: GeminiTool[]): OpenAITool[];
export declare function mapGeminiToOpenAI(geminiBody: GeminiRequestBody, modelName: string, stateKey?: string): OpenAIRequestBody;
export declare function mapOpenAIToGemini(openAiRes: OpenAIResponse, modelName: string, toolSchemas?: ToolSchemas): GeminiGenerateContentResponse;
export declare function mapOpenAIChunkToGemini(chunk: OpenAIResponse, modelName: string, streamKey?: string, toolSchemas?: ToolSchemas): GeminiCandidate | null;
export { mapGeminiToolsToOpenAI };
//# sourceMappingURL=openai.d.ts.map