/**
 * Centralized model capability detection.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */

// ─── Types ────────────────────────────────────────────────────────────────

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
}

export interface ModelNameCapabilities {
  isClaudeThinkingModel: boolean;
  isThinkingModel: boolean;
}

// ─── Detection ────────────────────────────────────────────────────────────

const THINKING_PATTERN = /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i;
const DEEPSEEK_PATTERN = /deepseek/i;
const CLAUDE_PATTERN = /claude|opus|sonnet/i;
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;

/**
 * Detects model capabilities from a custom model config object.
 */
export function detectModelCapabilities(m: CustomModelConfig, includeDisplayName = true): ModelCapabilities {
  const nameLower = (m.name || '').toLowerCase();
  const extLower = (m.externalModelName || '').toLowerCase();
  const displayLower = includeDisplayName ? (m.displayName || '').toLowerCase() : '';

  const isThinking =
    m.provider === 'anthropic' ||
    m.provider === 'openai' ||
    THINKING_PATTERN.test(nameLower) ||
    THINKING_PATTERN.test(extLower) ||
    (includeDisplayName && THINKING_PATTERN.test(displayLower));

  const isDeepSeek =
    DEEPSEEK_PATTERN.test(nameLower) ||
    DEEPSEEK_PATTERN.test(extLower) ||
    (includeDisplayName && DEEPSEEK_PATTERN.test(displayLower));

  const isClaude =
    m.provider === 'anthropic' ||
    CLAUDE_PATTERN.test(nameLower) ||
    CLAUDE_PATTERN.test(extLower);

  const maxTokens = isClaude ? 200_000 : 1_048_576;
  const maxOutputTokens = isDeepSeek ? 32_768 : (isThinking ? 32_768 : 16_384);

  return { isThinking, isDeepSeek, isClaude, maxTokens, maxOutputTokens };
}

/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities {
  const lower = (modelName || '').toLowerCase();
  return {
    isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
    isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
  };
}
