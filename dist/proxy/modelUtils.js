"use strict";
/**
 * Centralized model capability detection.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectModelCapabilities = detectModelCapabilities;
exports.detectModelCapabilitiesByName = detectModelCapabilitiesByName;
// ─── Detection ────────────────────────────────────────────────────────────
const THINKING_PATTERN = /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i;
const DEEPSEEK_PATTERN = /deepseek/i;
const CLAUDE_PATTERN = /claude|opus|sonnet/i;
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;
const IMAGE_SUPPORT_PATTERN = /gpt-4o|gpt-4-turbo|claude|gemini|vision|llava|qwenvl|pixtral|yi-vision|cogvlm|kimi|moonshot/i;
const NO_IMAGE_PATTERN = /deepseek(?!.*vision)|llama(?!.*vision)|mixtral(?!.*vision)|mistral(?!.*pixtral)|codestral|qwen(?!.*vl)/i;
/**
 * Detects model capabilities from a custom model config object.
 */
function detectModelCapabilities(m, includeDisplayName = true) {
    const nameLower = (m.name || '').toLowerCase();
    const extLower = (m.externalModelName || '').toLowerCase();
    const displayLower = includeDisplayName ? (m.displayName || '').toLowerCase() : '';
    const isThinking = m.provider === 'anthropic' ||
        m.provider === 'openai' ||
        m.provider === 'openrouter' ||
        THINKING_PATTERN.test(nameLower) ||
        THINKING_PATTERN.test(extLower) ||
        (includeDisplayName && THINKING_PATTERN.test(displayLower));
    const isDeepSeek = DEEPSEEK_PATTERN.test(nameLower) ||
        DEEPSEEK_PATTERN.test(extLower) ||
        (includeDisplayName && DEEPSEEK_PATTERN.test(displayLower));
    const isClaude = m.provider === 'anthropic' || CLAUDE_PATTERN.test(nameLower) || CLAUDE_PATTERN.test(extLower);
    const maxTokens = isClaude ? 200000 : 1048576;
    const maxOutputTokens = isDeepSeek ? 32768 : isThinking ? 32768 : 16384;
    // Image support: Claude, GPT-4o, Gemini always support images. DeepSeek, Ollama text models don't.
    const allNames = nameLower + ' ' + extLower + ' ' + displayLower;
    const supportsImages = m.provider === 'anthropic' ||
        m.provider === 'google' ||
        (m.provider === 'openai' && IMAGE_SUPPORT_PATTERN.test(allNames)) ||
        (m.provider === 'openrouter' && IMAGE_SUPPORT_PATTERN.test(allNames)) ||
        (IMAGE_SUPPORT_PATTERN.test(allNames) && !NO_IMAGE_PATTERN.test(allNames));
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