/**
 * Centralized model capability detection.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */
export interface CustomModelConfig {
    name: string;
    provider: string;
    externalModelName?: string;
    displayName?: string;
}
export interface ModelCapabilities {
    isThinking: boolean;
    isDeepSeek: boolean;
    isClaude: boolean;
    maxTokens: number;
    maxOutputTokens: number;
    supportsImages: boolean;
}
export interface ModelNameCapabilities {
    isClaudeThinkingModel: boolean;
    isThinkingModel: boolean;
}
/**
 * Detects model capabilities from a custom model config object.
 */
export declare function detectModelCapabilities(m: CustomModelConfig, includeDisplayName?: boolean): ModelCapabilities;
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export declare function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities;
//# sourceMappingURL=modelUtils.d.ts.map