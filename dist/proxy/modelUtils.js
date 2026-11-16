"use strict";
/**
 * Centralized model capability detection with OmniNorm CatalogResolver integration.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD = exports.COMPACTION_TOKEN_RESERVE = void 0;
exports.nativeCheckpointConfig = nativeCheckpointConfig;
exports.nativeModelExperiments = nativeModelExperiments;
exports.nativeCatalogCapabilities = nativeCatalogCapabilities;
exports.detectModelCapabilities = detectModelCapabilities;
exports.detectModelCapabilitiesByName = detectModelCapabilitiesByName;
const catalogResolver_mjs_1 = require("../norm/catalogResolver.mjs");
/** Extra room for the native checkpoint prompt and a final tool result. */
exports.COMPACTION_TOKEN_RESERVE = 1024;
exports.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD = 50000;
/** Keep the provider's real context/output limits; only change the IDE checkpoint policy. */
function nativeCheckpointConfig(model) {
    const config = {};
    const cap = detectModelCapabilities(model);
    // The manager can list old hand-edited files before a save validates them.
    // Do not turn malformed capability values into an active native override.
    if (!Number.isSafeInteger(cap.maxTokens) ||
        !Number.isSafeInteger(cap.maxOutputTokens) ||
        cap.maxOutputTokens <= 0 ||
        cap.maxTokens <= cap.maxOutputTokens)
        return undefined;
    if (model.compactionReasoningEffort &&
        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(model.compactionReasoningEffort)) {
        config.useLastPlannerModel = true;
        // The native default is an 8192-token summary. Its validator rejects a
        // checkpoint config if the selected custom model cannot emit that much.
        config.maxOutputTokens = Math.min(8192, cap.maxOutputTokens);
    }
    const percent = model.compactionThresholdPercent;
    if (percent !== undefined) {
        const maxTokenLimit = cap.maxTokens - cap.maxOutputTokens - exports.COMPACTION_TOKEN_RESERVE;
        const tokenThreshold = Math.min(Math.floor((cap.maxTokens * percent) / 100), maxTokenLimit);
        // Validation rejects unusable limits. Older hand-edited files fail closed.
        if (Number.isSafeInteger(percent) &&
            percent >= 10 &&
            percent <= 90 &&
            Number.isSafeInteger(model.contextWindow) &&
            Number.isSafeInteger(tokenThreshold) &&
            tokenThreshold >= 1024 &&
            maxTokenLimit >= exports.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD) {
            config.maxTokenLimit = maxTokenLimit;
            // Native IDE independently checks new tokens since the last checkpoint
            // and total input against these fields. Leaving the old 50k threshold
            // would still trigger a checkpoint before a larger configured limit.
            config.tokenThreshold = tokenThreshold;
        }
    }
    return Object.keys(config).length ? config : undefined;
}
/** Shared by the proxy catalog and the sandbox preload's IPC fallback. */
function nativeModelExperiments(model) {
    const checkpoint = nativeCheckpointConfig(model);
    return checkpoint
        ? { experiments: { CASCADE_USE_EXPERIMENT_CHECKPOINTER: { stringValue: JSON.stringify(checkpoint) } } }
        : undefined;
}
/**
 * IDE 2.5.5 validates its 50k threshold / 40k reserve defaults BEFORE reading
 * the per-model override. Only its catalog needs this compatibility floor.
 * The default 50k input budget must still fit the real provider before the
 * experiment cache warms. Saved limits, provider trimming and the override
 * itself always use detectModelCapabilities() and the real context window.
 */
function nativeCatalogCapabilities(model) {
    const cap = detectModelCapabilities(model);
    const checkpoint = nativeCheckpointConfig(model);
    if (checkpoint?.tokenThreshold === undefined || checkpoint.maxTokenLimit < exports.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD)
        return cap;
    return {
        ...cap,
        maxTokens: Math.max(cap.maxTokens, exports.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD + Math.max(40000, cap.maxOutputTokens)),
    };
}
// ─── Detection ────────────────────────────────────────────────────────────
const THINKING_PATTERN = /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i;
const DEEPSEEK_PATTERN = /deepseek/i;
const CLAUDE_PATTERN = /claude|opus|sonnet/i;
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;
const IMAGE_SUPPORT_PATTERN = /gpt-4o|gpt-4-turbo|claude|gemini|vision|llava|qwenvl|pixtral|yi-vision|cogvlm|kimi|moonshot/i;
// Positive family matches avoid excluding vision models just because their name
// also contains a provider's text-only model family (for example DeepSeek-VL2).
const DEEPSEEK_IMAGE_PATTERN = /(?:^|[\s/])(?:deepseek[-_ ]?vl2?|janus(?:[-_ ]?pro)?|deepseek-flash|deepseek-v4\.1-flash)(?=$|[-_:/\s])/i;
/**
 * Detects model capabilities from a custom model config object using OmniNorm CatalogResolver.
 */
function detectModelCapabilities(m, includeDisplayName = true) {
    const nameLower = (m.name || '').toLowerCase();
    const extLower = (m.externalModelName || '').toLowerCase();
    const displayLower = includeDisplayName ? (m.displayName || '').toLowerCase() : '';
    const allNames = nameLower + ' ' + extLower + ' ' + displayLower;
    // OmniNorm CatalogResolver lookup
    // Only a known catalog entry may override the name/provider fallbacks below;
    // unknown models keep the local heuristics.
    const spec = catalogResolver_mjs_1.defaultCatalogResolver.lookupKnownSpec(m.externalModelName || m.name, m.apiUrl || '') ?? {};
    const isThinking = m.supportsThinking ??
        spec.supportsReasoning ??
        (m.provider === 'anthropic' ||
            m.provider === 'openai' ||
            m.provider === 'openrouter' ||
            THINKING_PATTERN.test(nameLower) ||
            THINKING_PATTERN.test(extLower) ||
            (includeDisplayName && THINKING_PATTERN.test(displayLower)));
    const isDeepSeek = DEEPSEEK_PATTERN.test(nameLower) ||
        DEEPSEEK_PATTERN.test(extLower) ||
        (includeDisplayName && DEEPSEEK_PATTERN.test(displayLower));
    const isClaude = m.provider === 'anthropic' || CLAUDE_PATTERN.test(nameLower) || CLAUDE_PATTERN.test(extLower);
    const maxTokens = m.contextWindow ?? spec.contextWindow ?? (isClaude ? 200000 : 1048576);
    const maxOutputTokens = m.maxOutputTokens ?? spec.maxOutputTokens ?? (isDeepSeek ? 32768 : isThinking ? 32768 : 16384);
    // Explicit configuration (including imported provider metadata) wins over
    // provider/name fallbacks, in both directions. Unknown models remain text-only.
    // Known multimodal DeepSeek families override a catalog `false`.
    const supportsImages = m.supportsVision ??
        (DEEPSEEK_IMAGE_PATTERN.test(allNames) ? true : undefined) ??
        spec.supportsVision ??
        (m.provider === 'anthropic' ||
            m.provider === 'google' ||
            IMAGE_SUPPORT_PATTERN.test(allNames) ||
            DEEPSEEK_IMAGE_PATTERN.test(allNames));
    return { isThinking, isDeepSeek, isClaude, maxTokens, maxOutputTokens, supportsImages };
}
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
function detectModelCapabilitiesByName(modelName) {
    const lower = (modelName || '').toLowerCase();
    return {
        isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
        isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
    };
}
//# sourceMappingURL=modelUtils.js.map