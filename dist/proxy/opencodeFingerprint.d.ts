export declare const OPENCODE_CORE_TOOL_NAMES: readonly ["shell", "edit", "glob", "grep", "read"];
export declare const OPENCODE_CORE_TOOLS: Record<string, {
    description: string;
    parameters: Record<string, unknown>;
}>;
export declare const OPENCODE_KNOWN_FREE_MODELS: Set<string>;
/**
 * Checks whether a model is eligible for OpenCode free / keyless tier.
 */
export declare function isOpencodeFreeModel(modelName?: string): boolean;
/**
 * Checks whether the provider is an OpenCode provider.
 */
export declare function isOpencodeProvider(provider?: string): boolean;
/**
 * Generates an OpenCode session ID matching the official Identifier.descending() layout:
 * `ses_` + 12 lowercase hex characters (inverted timestamp + counter) + 14 Base62 characters.
 */
export declare function canonicalSessionID(signal?: string): string;
/**
 * Generates a bare 40-character lowercase hex project ID matching what official OpenCode sends.
 */
export declare function clientProjectID(project?: string): string;
/**
 * Official client User-Agent required by the OpenCode free tier gate.
 */
export declare const OPENCODE_USER_AGENT = "opencode/latest/2.0.29/cli";
/**
 * Builds all required OpenCode client fingerprint headers for free/paid requests.
 */
export declare function buildOpencodeHeaders(apiKey?: string, sessionSeed?: string): Record<string, string>;
/**
 * Normalizes an OpenCode endpoint. Keyless/free-tier inference uses `https://opencode.ai/inference`.
 */
export declare function normalizeOpencodeEndpoint(apiUrl: string, modelName?: string, isResponsesFormat?: boolean): string;
/**
 * Injects genuine core agent tools into the request body as enforced by OpenCode's free tier.
 */
export declare function prepareOpencodeFreeBody(body: Record<string, any>, isResponsesFormat?: boolean): Record<string, any>;
/**
 * Reconstructs a full JSON chat completion response from forced SSE event stream data.
 */
export declare function parseSSEToOpenAIResponse(rawSSE: string, fallbackModel?: string): Record<string, any> | null;
//# sourceMappingURL=opencodeFingerprint.d.ts.map