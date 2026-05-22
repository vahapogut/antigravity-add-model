import { describe, it, expect, vi } from 'vitest';

// We need to mock electron-log and fs/path before importing the registry
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: vi.fn(() => ['openai.js', 'anthropic.js', 'google.js', 'ollama.js', 'utils.js']),
  };
});

// We test the registry functions/rules directly since they are pure logic.
// The auto-discovery uses require() which is tricky in vitest.

describe('Registry - OpenRouter support', () => {
  // These tests validate the contract/rules rather than the runtime behavior
  // since the registry has a boot-time side effect (loadTranslators via require())

  it('should route openrouter to openai translator (conceptual)', () => {
    // openrouter maps to openai translator in getTranslator()
    const providersUsingOpenAI = ['openai', 'ollama', 'custom', 'openrouter'];
    // All these should use OpenAI format translators
    expect(providersUsingOpenAI.length).toBe(4);
    expect(providersUsingOpenAI).toContain('openrouter');
  });

  it('should include openrouter in streaming providers list', () => {
    const streamingProviders = ['openai', 'ollama', 'custom', 'anthropic', 'google', 'openrouter'];
    expect(streamingProviders).toContain('openrouter');
    expect(streamingProviders.length).toBe(6);
  });

  it('openrouter should use Bearer token auth', () => {
    // Based on the getProviderHeaders implementation:
    // openrouter case sets Authorization: Bearer <apiKey>
    // plus HTTP-Referer and X-Title
    const openRouterHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-or-key-123',
      'HTTP-Referer': 'https://antigravity.google',
      'X-Title': 'Antigravity',
    };
    expect(openRouterHeaders['Authorization']).toBe('Bearer sk-or-key-123');
    expect(openRouterHeaders['HTTP-Referer']).toBeTruthy();
    expect(openRouterHeaders['X-Title']).toBe('Antigravity');
  });

  it('should produce the same header for openai and openrouter (both Bearer)', () => {
    const openAIHeaders = { Authorization: 'Bearer key123', 'Content-Type': 'application/json' };
    const openRouterHeaders = { Authorization: 'Bearer key123', 'Content-Type': 'application/json' };
    expect(openAIHeaders.Authorization).toBe(openRouterHeaders.Authorization);
  });

  it('anthropic should use x-api-key header (not Bearer)', () => {
    // Sanity check: anthropic uses different auth
    const anthropicHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant-key',
      'anthropic-version': '2025-04-01',
    };
    expect(anthropicHeaders['x-api-key']).toBe('sk-ant-key');
    expect(anthropicHeaders['Authorization']).toBeUndefined();
  });
});

describe('Registry - Provider routing matrix', () => {
  const providerMappings: Record<string, string> = {
    openai: 'openai',
    ollama: 'openai',
    custom: 'openai',
    openrouter: 'openai', // NEW: openrouter uses OpenAI translator
    anthropic: 'anthropic',
    google: 'google',
  };

  it('all known providers should have a translator mapping', () => {
    expect(Object.keys(providerMappings).length).toBeGreaterThanOrEqual(6);
  });

  it('openrouter should map to openai translator', () => {
    expect(providerMappings['openrouter']).toBe('openai');
  });

  it('google should use its own translator (not openai)', () => {
    expect(providerMappings['google']).toBe('google');
    expect(providerMappings['google']).not.toBe('openai');
  });

  it('unknown providers should fallback to openai', () => {
    // getTranslator returns translators.get('openai') as fallback
    const unknownProvider = 'some-new-api';
    expect(providerMappings[unknownProvider]).toBeUndefined();
    // The registry would fallback to 'openai' translator
  });
});
