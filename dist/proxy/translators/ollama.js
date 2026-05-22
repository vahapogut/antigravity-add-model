"use strict";
/**
 * Ollama Translator.
 *
 * Ollama is fully OpenAI-compatible (channels/v1/chat/completions).
 * This module re-exports the OpenAI translator functions and adds
 * Ollama-specific helpers:
 *   - Default URL normalization (localhost:11434 fallback)
 *   - User-friendly error message translation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapOpenAIChunkToGemini = exports.mapOpenAIToGemini = exports.mapGeminiToOpenAI = void 0;
exports.getOllamaApiUrl = getOllamaApiUrl;
exports.translateOllamaError = translateOllamaError;
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Re-export all OpenAI translator functions ────────────────────────────
// The registry auto-discovers these by naming convention:
//   mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini
// Ollama uses the exact same format, so we re-export verbatim.
var openai_1 = require("./openai");
Object.defineProperty(exports, "mapGeminiToOpenAI", { enumerable: true, get: function () { return openai_1.mapGeminiToOpenAI; } });
Object.defineProperty(exports, "mapOpenAIToGemini", { enumerable: true, get: function () { return openai_1.mapOpenAIToGemini; } });
Object.defineProperty(exports, "mapOpenAIChunkToGemini", { enumerable: true, get: function () { return openai_1.mapOpenAIChunkToGemini; } });
// ─── Ollama-Specific Helpers ──────────────────────────────────────────────
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
function getOllamaApiUrl(baseUrl) {
    let url = baseUrl;
    // If it already has a specific API path, don't touch it
    if (url.includes('/api/')) {
        return url;
    }
    // Clean trailing slash
    url = url.replace(/\/$/, '');
    // If no port on localhost, use default Ollama port
    if (url.match(/^https?:\/\/localhost$/)) {
        url = 'http://localhost:11434';
        electron_log_1.default.info('[OllamaTranslator] Added default Ollama port 11434');
    }
    // If URL ends with /v1, append /chat/completions
    if (url.endsWith('/v1')) {
        url += '/chat/completions';
        return url;
    }
    // If URL doesn't have a chat completions path, add full /v1/chat/completions
    if (!url.includes('/chat/completions') && !url.includes('/completions')) {
        url += '/v1/chat/completions';
    }
    return url;
}
/**
 * Translate raw Ollama errors into user-friendly messages.
 */
function translateOllamaError(statusCode, body) {
    // Connection refused — Ollama service not running
    if (body.includes('ECONNREFUSED') || body.includes('connect ECONNREFUSED')) {
        return 'Ollama is not running. Start it with `ollama serve` or launch the Ollama desktop app.';
    }
    // Model not pulled yet
    if (statusCode === 404 || (body.includes('model') && body.includes('not found'))) {
        const modelMatch = body.match(/model ['"]([^'"]+)['"]/);
        const modelName = modelMatch ? modelMatch[1] : 'unknown';
        return `Ollama model "${modelName}" not found. Pull it: ollama pull ${modelName}`;
    }
    // Server-side errors (OOM, crash, etc.)
    if (statusCode >= 500) {
        return `Ollama server error (${statusCode}). Check if Ollama has enough resources (RAM/VRAM).`;
    }
    // Generic fallback with truncated body
    const snippet = body.substring(0, 200);
    return `Ollama error (${statusCode}): ${snippet}`;
}
//# sourceMappingURL=ollama.js.map