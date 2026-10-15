/** Wire-format dispatch, independent from provider branding and authentication. */
import * as openai from './translators/openai';
import * as anthropic from './translators/anthropic';
import * as google from './translators/google';
import { ApiFormat, resolveApiFormat } from '../providers';
import type { ToolSchemas } from './translators/utils';

export interface TranslatorModule {
  [key: string]: unknown;
}
export interface ProviderHeaders {
  'Content-Type': string;
  [key: string]: string | undefined;
}

export function getTranslator(provider: string, apiFormat?: ApiFormat): TranslatorModule {
  const format = resolveApiFormat(provider, apiFormat);
  return format === 'google' ? google : format === 'anthropic' ? anthropic : openai;
}

export function translateRequest(
  provider: string,
  body: unknown,
  modelName: string,
  apiFormat?: ApiFormat,
  stateKey?: string,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  if (format === 'google') return google.mapGeminiToGoogle(body as never, modelName);
  if (format === 'anthropic') return anthropic.mapGeminiToAnthropic(body as never, modelName, stateKey);
  return openai.mapGeminiToOpenAI(body as never, modelName, stateKey);
}

export function translateResponse(
  provider: string,
  response: unknown,
  stateKey: string,
  apiFormat?: ApiFormat,
  toolSchemas?: ToolSchemas,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  if (format === 'google') return google.mapGoogleToGemini(response, stateKey);
  if (format === 'anthropic') return anthropic.mapAnthropicToGemini(response as never, stateKey, toolSchemas);
  return openai.mapOpenAIToGemini(response as never, stateKey, toolSchemas);
}

export function translateStreamChunk(
  provider: string,
  chunk: unknown,
  stateKey: string,
  apiFormat?: ApiFormat,
  streamKey?: string,
  toolSchemas?: ToolSchemas,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  if (format === 'google') return google.mapGoogleChunkToGemini(chunk, stateKey);
  if (format === 'anthropic')
    return anthropic.mapAnthropicChunkToGemini(chunk as never, stateKey, streamKey, toolSchemas);
  return openai.mapOpenAIChunkToGemini(chunk as never, stateKey, streamKey, toolSchemas);
}

export function getProviderHeaders(provider: string, apiKey = '', apiFormat?: ApiFormat): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };
  const format = resolveApiFormat(provider, apiFormat);
  if (format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (apiKey && apiKey !== 'none') {
    if (/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(apiKey))
      throw new Error('API key could not be decrypted; save the key again.');
    if (format === 'google') headers['x-goog-api-key'] = apiKey;
    else if (format === 'anthropic') headers['x-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://antigravity.google';
    headers['X-Title'] = 'Antigravity';
  }
  if (['opencode', 'zen', 'opencode-go'].includes(provider)) {
    headers['User-Agent'] = 'opencode/latest/2.0.29/cli';
    if (!headers.Authorization) {
      headers.Authorization = 'Bearer public';
    }
  }
  return headers;
}

export function supportsStreaming(_provider: string): boolean {
  return true;
}

export function getProviderUrl(
  baseUrl: string,
  modelName: string,
  isStream: boolean,
  translator: TranslatorModule | null,
): string {
  if (typeof translator?.getGoogleApiUrl === 'function')
    return translator.getGoogleApiUrl(baseUrl, modelName, isStream);
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  const anthropicFormat = translator === anthropic;
  pathname = pathname.replace(/\/(?:chat\/completions|completions|messages)$/, '');
  if (!pathname) pathname = '/v1';
  pathname += anthropicFormat ? '/messages' : '/chat/completions';
  url.pathname = pathname;
  return url.toString();
}
