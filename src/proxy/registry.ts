/**
 * Provider Translator Registry.
 * Auto-discovers translator modules and provides a unified interface for request/response mapping.
 *
 * To add a new provider:
 *   1. Create a file in ./translators/ named <provider>.ts
 *   2. Export: mapGeminiTo<Provider>, map<Provider>ToGemini, map<Provider>ChunkToGemini
 *   3. The registry detects it automatically — no config changes needed.
 */

import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TranslatorModule {
  mapGeminiToOpenAI?: (body: unknown, modelName: string) => unknown;
  mapOpenAIToGemini?: (res: unknown, modelName: string) => unknown;
  mapOpenAIChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGeminiToAnthropic?: (body: unknown, modelName: string) => unknown;
  mapAnthropicToGemini?: (res: unknown, modelName: string) => unknown;
  mapAnthropicChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGeminiToGoogle?: (body: unknown, modelName: string) => unknown;
  mapGoogleToGemini?: (res: unknown, modelName: string) => unknown;
  mapGoogleChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  getGoogleApiUrl?: (baseUrl: string, modelName: string, isStream: boolean) => string;
  [key: string]: unknown;
}

export interface ProviderHeaders {
  'Content-Type': string;
  Authorization?: string;
  'x-api-key'?: string;
  'anthropic-version'?: string;
  'x-goog-api-key'?: string;
  'HTTP-Referer'?: string;
  'X-Title'?: string;
  [key: string]: string | undefined;
}

// ─── Registry State ───────────────────────────────────────────────────────

const translators = new Map<string, TranslatorModule>();

// ─── Auto-Discovery ───────────────────────────────────────────────────────

function loadTranslators(): void {
  const translatorDir = path.join(__dirname, 'translators');

  try {
    const files = fs.readdirSync(translatorDir).filter((f) => f.endsWith('.js') && f !== 'utils.js');

    for (const file of files) {
      const provider = path.basename(file, '.js');
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(path.join(translatorDir, file)) as TranslatorModule;
        translators.set(provider, mod);
        log.info(`[TranslatorRegistry] Loaded provider translator: "${provider}"`);
      } catch (err) {
        log.error(`[TranslatorRegistry] Failed to load translator "${provider}":`, (err as Error).message);
      }
    }
  } catch (err) {
    log.error('[TranslatorRegistry] Failed to scan translators directory:', (err as Error).message);
  }

  log.info(
    `[TranslatorRegistry] ${translators.size} provider translator(s) loaded: ${[...translators.keys()].join(', ')}`,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getTranslator(provider: string): TranslatorModule | null {
  // openrouter uses OpenAI-compatible API — reuse OpenAI translator
  if (provider === 'openrouter') return translators.get('openai') || null;
  const key = provider === 'custom' ? 'openai' : provider;
  return translators.get(key) || translators.get('openai') || null;
}

export function translateRequest(provider: string, geminiBody: unknown, modelName: string): unknown {
  const t = getTranslator(provider);

  if (provider === 'google') {
    return geminiBody; // passthrough
  }

  if (provider === 'openai' || provider === 'ollama' || provider === 'custom' || provider === 'openrouter') {
    return t?.mapGeminiToOpenAI ? t.mapGeminiToOpenAI(geminiBody, modelName) : geminiBody;
  }

  if (provider === 'anthropic') {
    return t?.mapGeminiToAnthropic ? t.mapGeminiToAnthropic(geminiBody, modelName) : geminiBody;
  }

  // Generic: try mapGeminiTo<Provider> convention
  const fnName = `mapGeminiTo${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(geminiBody, modelName);
  }

  log.warn(`[TranslatorRegistry] No request translator for provider "${provider}", passing through`);
  return geminiBody;
}

export function translateResponse(provider: string, providerRes: unknown, modelName: string): unknown {
  const t = getTranslator(provider);

  if (provider === 'google') return providerRes;

  if (provider === 'openai' || provider === 'ollama' || provider === 'custom' || provider === 'openrouter') {
    return t?.mapOpenAIToGemini ? t.mapOpenAIToGemini(providerRes, modelName) : providerRes;
  }

  if (provider === 'anthropic') {
    return t?.mapAnthropicToGemini ? t.mapAnthropicToGemini(providerRes, modelName) : providerRes;
  }

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(providerRes, modelName);
  }

  log.warn(`[TranslatorRegistry] No response translator for provider "${provider}", passing through`);
  return providerRes;
}

export function translateStreamChunk(provider: string, chunk: unknown, modelName: string): unknown {
  const t = getTranslator(provider);

  if (provider === 'google') {
    return t?.mapGoogleChunkToGemini ? t.mapGoogleChunkToGemini(chunk, modelName) : null;
  }

  if (provider === 'openai' || provider === 'ollama' || provider === 'custom' || provider === 'openrouter') {
    return t?.mapOpenAIChunkToGemini ? t.mapOpenAIChunkToGemini(chunk, modelName) : null;
  }

  if (provider === 'anthropic') {
    return t?.mapAnthropicChunkToGemini ? t.mapAnthropicChunkToGemini(chunk, modelName) : null;
  }

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ChunkToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(chunk, modelName);
  }

  return null;
}

export function getProviderHeaders(provider: string, apiKey: string): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };

  switch (provider) {
    case 'openai':
    case 'custom':
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'openrouter':
      headers['Authorization'] = `Bearer ${apiKey}`;
      // OpenRouter optional headers for leaderboard attribution
      headers['HTTP-Referer'] = 'https://antigravity.google';
      headers['X-Title'] = 'Antigravity';
      break;
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2025-04-01';
      break;
    case 'google':
      headers['x-goog-api-key'] = apiKey;
      break;
    case 'ollama':
      // Ollama typically doesn't need auth headers
      break;
    default:
      if (apiKey && apiKey !== 'none') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      break;
  }

  return headers;
}

export function supportsStreaming(provider: string): boolean {
  return ['openai', 'ollama', 'custom', 'anthropic', 'google', 'openrouter'].includes(provider);
}

// ─── URL Helpers ──────────────────────────────────────────────────────────

export function getProviderUrl(
  baseUrl: string,
  modelName: string,
  isStream: boolean,
  translator: TranslatorModule | null,
): string {
  // Google AI Studio: dynamic streaming vs non-streaming URL
  if (translator && typeof translator['getGoogleApiUrl'] === 'function') {
    return (translator['getGoogleApiUrl'] as (...args: unknown[]) => string)(baseUrl, modelName, isStream);
  }
  // Ollama: normalize to standard /v1/chat/completions endpoint
  if (translator && typeof translator['getOllamaApiUrl'] === 'function') {
    return (translator['getOllamaApiUrl'] as (...args: unknown[]) => string)(baseUrl);
  }
  return baseUrl;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

loadTranslators();
