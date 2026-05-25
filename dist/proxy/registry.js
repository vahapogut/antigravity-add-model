"use strict";
/**
 * Provider Translator Registry.
 * Auto-discovers translator modules and provides a unified interface for request/response mapping.
 *
 * To add a new provider:
 *   1. Create a file in ./translators/ named <provider>.ts
 *   2. Export: mapGeminiTo<Provider>, map<Provider>ToGemini, map<Provider>ChunkToGemini
 *   3. The registry detects it automatically — no config changes needed.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTranslator = getTranslator;
exports.translateRequest = translateRequest;
exports.translateResponse = translateResponse;
exports.translateStreamChunk = translateStreamChunk;
exports.getProviderHeaders = getProviderHeaders;
exports.supportsStreaming = supportsStreaming;
exports.getProviderUrl = getProviderUrl;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Registry State ───────────────────────────────────────────────────────
const translators = new Map();
// ─── Auto-Discovery ───────────────────────────────────────────────────────
function loadTranslators() {
    const translatorDir = path.join(__dirname, 'translators');
    try {
        const files = fs.readdirSync(translatorDir).filter((f) => f.endsWith('.js') && f !== 'utils.js');
        for (const file of files) {
            const provider = path.basename(file, '.js');
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const mod = require(path.join(translatorDir, file));
                translators.set(provider, mod);
                electron_log_1.default.info(`[TranslatorRegistry] Loaded provider translator: "${provider}"`);
            }
            catch (err) {
                electron_log_1.default.error(`[TranslatorRegistry] Failed to load translator "${provider}":`, err.message);
            }
        }
    }
    catch (err) {
        electron_log_1.default.error('[TranslatorRegistry] Failed to scan translators directory:', err.message);
    }
    electron_log_1.default.info(`[TranslatorRegistry] ${translators.size} provider translator(s) loaded: ${[...translators.keys()].join(', ')}`);
}
// Providers grouped by transport compatibility
const OPENAI_COMPAT = new Set(['openai', 'ollama', 'openrouter', 'custom', 'groq', 'mistral', 'cerebras', 'nvidia', 'opencode', 'codestral']);
const ANTHROPIC_COMPAT = new Set(['anthropic', 'deepseek', 'kimi', 'fireworks', 'lmstudio', 'llamacpp', 'wafer', 'zai']);
// ─── Public API ───────────────────────────────────────────────────────────
function getTranslator(provider) {
    if (OPENAI_COMPAT.has(provider))
        return translators.get('openai') || null;
    if (ANTHROPIC_COMPAT.has(provider))
        return translators.get('anthropic') || null;
    if (provider === 'google')
        return translators.get('google') || null;
    return translators.get('openai') || null;
}
function translateRequest(provider, geminiBody, modelName) {
    const t = getTranslator(provider);
    if (provider === 'google')
        return geminiBody;
    if (OPENAI_COMPAT.has(provider))
        return t?.mapGeminiToOpenAI ? t.mapGeminiToOpenAI(geminiBody, modelName) : geminiBody;
    if (ANTHROPIC_COMPAT.has(provider))
        return t?.mapGeminiToAnthropic ? t.mapGeminiToAnthropic(geminiBody, modelName) : geminiBody;
    // Generic: try mapGeminiTo<Provider> convention
    const fnName = `mapGeminiTo${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
    if (t && typeof t[fnName] === 'function') {
        return t[fnName](geminiBody, modelName);
    }
    electron_log_1.default.warn(`[TranslatorRegistry] No request translator for provider "${provider}", passing through`);
    return geminiBody;
}
function translateResponse(provider, providerRes, modelName) {
    const t = getTranslator(provider);
    if (provider === 'google')
        return providerRes;
    if (OPENAI_COMPAT.has(provider))
        return t?.mapOpenAIToGemini ? t.mapOpenAIToGemini(providerRes, modelName) : providerRes;
    if (ANTHROPIC_COMPAT.has(provider))
        return t?.mapAnthropicToGemini ? t.mapAnthropicToGemini(providerRes, modelName) : providerRes;
    const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ToGemini`;
    if (t && typeof t[fnName] === 'function') {
        return t[fnName](providerRes, modelName);
    }
    electron_log_1.default.warn(`[TranslatorRegistry] No response translator for provider "${provider}", passing through`);
    return providerRes;
}
function translateStreamChunk(provider, chunk, modelName) {
    const t = getTranslator(provider);
    if (provider === 'google')
        return t?.mapGoogleChunkToGemini ? t.mapGoogleChunkToGemini(chunk, modelName) : null;
    if (OPENAI_COMPAT.has(provider))
        return t?.mapOpenAIChunkToGemini ? t.mapOpenAIChunkToGemini(chunk, modelName) : null;
    if (ANTHROPIC_COMPAT.has(provider))
        return t?.mapAnthropicChunkToGemini ? t.mapAnthropicChunkToGemini(chunk, modelName) : null;
    const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ChunkToGemini`;
    if (t && typeof t[fnName] === 'function') {
        return t[fnName](chunk, modelName);
    }
    return null;
}
function getProviderHeaders(provider, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (!apiKey || apiKey === 'none')
        return headers;
    if (provider === 'anthropic' || ANTHROPIC_COMPAT.has(provider)) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2025-04-01';
    }
    else if (provider === 'google') {
        headers['x-goog-api-key'] = apiKey;
    }
    else if (provider === 'openrouter') {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['HTTP-Referer'] = 'https://antigravity.google';
        headers['X-Title'] = 'Antigravity';
    }
    else if (provider !== 'ollama') {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
function supportsStreaming(provider) {
    return OPENAI_COMPAT.has(provider) || ANTHROPIC_COMPAT.has(provider) || provider === 'google';
}
// ─── URL Helpers ──────────────────────────────────────────────────────────
function getProviderUrl(baseUrl, modelName, isStream, translator) {
    // Google AI Studio: dynamic streaming vs non-streaming URL
    if (translator && typeof translator['getGoogleApiUrl'] === 'function') {
        return translator['getGoogleApiUrl'](baseUrl, modelName, isStream);
    }
    // Ollama: normalize to standard /v1/chat/completions endpoint
    if (translator && typeof translator['getOllamaApiUrl'] === 'function') {
        return translator['getOllamaApiUrl'](baseUrl);
    }
    return baseUrl;
}
// ─── Boot ─────────────────────────────────────────────────────────────────
loadTranslators();
//# sourceMappingURL=registry.js.map