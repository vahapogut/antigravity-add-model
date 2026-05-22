/**
 * Ollama Translator.
 *
 * Ollama is fully OpenAI-compatible (channels/v1/chat/completions).
 * This module re-exports the OpenAI translator functions and adds
 * Ollama-specific helpers:
 *   - Default URL normalization (localhost:11434 fallback)
 *   - User-friendly error message translation
 */
export { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from './openai';
/**
 * Normalizes an Ollama API URL to the standard chat completions endpoint.
 *
 * Handles these common patterns:
 *   http://localhost:11434              → http://localhost:11434/v1/chat/completions
 *   http://localhost:11434/v1           → http://localhost:11434/v1/chat/completions
 *   http://localhost                    → http://localhost:11434/v1/chat/completions
 *   http://10.0.0.5:11434/api/generate  → kept as-is (non-chat endpoint)
 *
 * If localhost has no port, defaults to Ollama's standard port 11434.
 */
export declare function getOllamaApiUrl(baseUrl: string): string;
/**
 * Translate raw Ollama errors into user-friendly messages.
 */
export declare function translateOllamaError(statusCode: number, body: string): string;
//# sourceMappingURL=ollama.d.ts.map