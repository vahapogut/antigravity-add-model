import { describe, it, expect } from 'vitest';
import { detectModelCapabilities, detectModelCapabilitiesByName } from '../proxy/modelUtils';

describe('detectModelCapabilities', () => {
  it('detects thinking for anthropic provider', () => {
    const result = detectModelCapabilities({ name: 'claude-3-5-sonnet', provider: 'anthropic' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(true);
    expect(result.maxTokens).toBe(200_000);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it('detects thinking for openai provider', () => {
    const result = detectModelCapabilities({ name: 'gpt-4o', provider: 'openai' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(false);
  });

  it('detects thinking for openrouter provider', () => {
    const result = detectModelCapabilities({ name: 'openai/gpt-4o', provider: 'openrouter' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(false);
    expect(result.maxTokens).toBe(1_048_576);
  });

  it('detects thinking by name pattern', () => {
    const result = detectModelCapabilities({
      name: 'deepseek-r1',
      provider: 'ollama',
      externalModelName: 'deepseek-r1',
    });
    expect(result.isThinking).toBe(true);
    expect(result.isDeepSeek).toBe(true);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it('detects o1/o3 style reasoning models', () => {
    const result = detectModelCapabilities({ name: 'o1-preview', provider: 'openai' });
    expect(result.isThinking).toBe(true);
  });

  it('detects opus-4 / sonnet-4 as thinking', () => {
    const result = detectModelCapabilities({ name: 'claude-sonnet-4', provider: 'anthropic' });
    expect(result.isThinking).toBe(true);
  });

  it('detects non-thinking ollama model', () => {
    const result = detectModelCapabilities({ name: 'llama3', provider: 'ollama' });
    expect(result.isThinking).toBe(false);
    expect(result.isDeepSeek).toBe(false);
    expect(result.isClaude).toBe(false);
    expect(result.maxTokens).toBe(1_048_576);
    expect(result.maxOutputTokens).toBe(16_384);
  });

  it('detects anthropic models as claude regardless of name', () => {
    const result = detectModelCapabilities({ name: 'some-unknown-model', provider: 'anthropic' });
    expect(result.isClaude).toBe(true);
  });

  it('detects claude by name pattern', () => {
    const result = detectModelCapabilities({ name: 'claude-haiku', provider: 'custom' });
    expect(result.isClaude).toBe(true);
  });

  it('detects deepseek by name', () => {
    const result = detectModelCapabilities({ name: 'deepseek-v3', provider: 'custom' });
    expect(result.isDeepSeek).toBe(true);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it('uses displayName for detection when includeDisplayName=true', () => {
    const result = detectModelCapabilities(
      { name: 'models/my-model', provider: 'ollama', displayName: 'DeepSeek R1 - Reasoning' },
      true,
    );
    expect(result.isDeepSeek).toBe(true);
    expect(result.isThinking).toBe(true);
  });

  it('skips displayName when includeDisplayName=false', () => {
    const result = detectModelCapabilities(
      { name: 'models/my-model', provider: 'ollama', displayName: 'DeepSeek R1 - Reasoning' },
      false,
    );
    expect(result.isDeepSeek).toBe(false);
  });

  it('detects by externalModelName', () => {
    const result = detectModelCapabilities({
      name: 'custom-model',
      provider: 'openrouter',
      externalModelName: 'anthropic/claude-3.5-sonnet',
    });
    expect(result.isClaude).toBe(true);
  });
});

describe('detectModelCapabilitiesByName', () => {
  it('detects claude thinking models', () => {
    const result = detectModelCapabilitiesByName('claude-3-5-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('detects claude 4 models as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-sonnet-4-20250514');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('detects opus-4 as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-opus-4');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('returns false for non-claude models', () => {
    const result = detectModelCapabilitiesByName('gpt-4o');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles claude-3-7 models', () => {
    const result = detectModelCapabilitiesByName('claude-3-7-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles empty/null input gracefully', () => {
    const result = detectModelCapabilitiesByName('');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });
});
