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
    return { isThinking, isDeepSeek, isClaude, maxTokens, maxOutputTokens };
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