/**
 * Google AI Studio Translator.
 *
 * Google AI Studio speaks Gemini format natively, so request/response
 * translation is a passthrough. The main addition is SSE streaming chunk
 * parsing and proper endpoint URL handling.
 */
interface GeminiPart {
    text?: string;
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    thought?: boolean;
    inlineData?: {
        mimeType: string;
        data: string;
    };
    fileData?: {
        mimeType: string;
        fileUri: string;
    };
}
interface GeminiContent {
    parts?: GeminiPart[];
    role?: string;
}
interface GeminiCandidate {
    content?: GeminiContent;
    finishReason?: string;
    index?: number;
    safetyRatings?: unknown[];
}
interface GeminiRequestBody {
    model?: string;
    modelId?: string;
    contents?: GeminiContent[];
    systemInstruction?: {
        parts: {
            text?: string;
        }[];
    };
    tools?: unknown[];
    generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
        topP?: number;
        topK?: number;
        stopSequences?: string[];
    };
}
/**
 * Google AI Studio uses the same Gemini format — just pass through.
 * The caller handles URL routing (streamGenerateContent vs generateContent).
 */
export declare function mapGeminiToGoogle(geminiBody: GeminiRequestBody, modelName: string): GeminiRequestBody;
/**
 * Google AI Studio returns Gemini-format responses directly.
 * Just pass through — the proxy wraps it in the Cloud Code envelope.
 */
export declare function mapGoogleToGemini(googleRes: unknown, _modelName: string): unknown;
/**
 * Parse a Google AI Studio SSE streaming chunk into a Gemini candidate.
 *
 * Google AI Studio streams JSON chunks like:
 *   {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},...}]}
 *
 * Each chunk contains complete candidate objects (not deltas).
 */
export declare function mapGoogleChunkToGemini(chunk: unknown, _modelName: string): GeminiCandidate | null;
/**
 * Constructs the correct Google AI Studio endpoint URL based on streaming mode.
 *
 * Google AI Studio uses different endpoints:
 *   - Non-streaming: :generateContent
 *   - Streaming:     :streamGenerateContent
 *
 * If the user's URL already contains one of these endpoints, it's kept as-is.
 */
export declare function getGoogleApiUrl(baseUrl: string, modelName: string, isStream: boolean): string;
export {};
//# sourceMappingURL=google.d.ts.map