/**
 * Centralized model capability detection with OmniNorm CatalogResolver integration.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */
export interface CustomModelConfig {
    name: string;
    provider: string;
    externalModelName?: string;
    displayName?: string;
    apiUrl?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    compactionReasoningEffort?: string;
    compactionThresholdPercent?: number;
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
export interface NativeCheckpointConfig {
    useLastPlannerModel?: boolean;
    maxOutputTokens?: number;
    tokenThreshold?: number;
    maxTokenLimit?: number;
}
/** Extra room for the native checkpoint prompt and a final tool result. */
export declare const COMPACTION_TOKEN_RESERVE = 1024;
export declare const NATIVE_DEFAULT_CHECKPOINT_THRESHOLD = 50000;
/** Keep the provider's real context/output limits; only change the IDE checkpoint policy. */
export declare function nativeCheckpointConfig(model: CustomModelConfig): NativeCheckpointConfig | undefined;
/** Shared by the proxy catalog and the sandbox preload's IPC fallback. */
export declare function nativeModelExperiments(model: CustomModelConfig): {
    experiments: {
        CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: string;
        };
    };
};
/**
 * IDE 2.5.5 validates its 50k threshold / 40k reserve defaults BEFORE reading
 * the per-model override. Only its catalog needs this compatibility floor.
 * The default 50k input budget must still fit the real provider before the
 * experiment cache warms. Saved limits, provider trimming and the override
 * itself always use detectModelCapabilities() and the real context window.
 */
export declare function nativeCatalogCapabilities(model: CustomModelConfig): ModelCapabilities;
/**
 * Detects model capabilities from a custom model config object using OmniNorm CatalogResolver.
 */
export declare function detectModelCapabilities(m: CustomModelConfig, includeDisplayName?: boolean): ModelCapabilities;
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export declare function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities;
//# sourceMappingURL=modelUtils.d.ts.map