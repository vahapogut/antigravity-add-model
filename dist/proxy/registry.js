"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTranslator = getTranslator;
exports.translateRequest = translateRequest;
exports.translateResponse = translateResponse;
exports.translateStreamChunk = translateStreamChunk;
exports.getProviderHeaders = getProviderHeaders;
exports.supportsStreaming = supportsStreaming;
exports.getProviderUrl = getProviderUrl;
/** Wire-format dispatch, independent from provider branding and authentication. */
const openai = __importStar(require("./translators/openai"));
const anthropic = __importStar(require("./translators/anthropic"));
const google = __importStar(require("./translators/google"));
const providers_1 = require("../providers");
function getTranslator(provider, apiFormat) {
    const format = (0, providers_1.resolveApiFormat)(provider, apiFormat);
    return format === 'google' ? google : format === 'anthropic' ? anthropic : openai;
}
function translateRequest(provider, body, modelName, apiFormat, stateKey) {
    const format = (0, providers_1.resolveApiFormat)(provider, apiFormat);
    if (format === 'google')
        return google.mapGeminiToGoogle(body, modelName);
    if (format === 'anthropic')
        return anthropic.mapGeminiToAnthropic(body, modelName, stateKey);
    return openai.mapGeminiToOpenAI(body, modelName, stateKey);
}
function translateResponse(provider, response, stateKey, apiFormat, toolSchemas) {
    const format = (0, providers_1.resolveApiFormat)(provider, apiFormat);
    if (format === 'google')
        return google.mapGoogleToGemini(response, stateKey);
    if (format === 'anthropic')
        return anthropic.mapAnthropicToGemini(response, stateKey, toolSchemas);
    return openai.mapOpenAIToGemini(response, stateKey, toolSchemas);
}
function translateStreamChunk(provider, chunk, stateKey, apiFormat, streamKey, toolSchemas) {
    const format = (0, providers_1.resolveApiFormat)(provider, apiFormat);
    if (format === 'google')
        return google.mapGoogleChunkToGemini(chunk, stateKey);
    if (format === 'anthropic')
        return anthropic.mapAnthropicChunkToGemini(chunk, stateKey, streamKey, toolSchemas);
    return openai.mapOpenAIChunkToGemini(chunk, stateKey, streamKey, toolSchemas);
}
function getProviderHeaders(provider, apiKey = '', apiFormat) {
    const headers = { 'Content-Type': 'application/json' };
    const format = (0, providers_1.resolveApiFormat)(provider, apiFormat);
    if (format === 'anthropic')
        headers['anthropic-version'] = '2023-06-01';
    if (apiKey && apiKey !== 'none') {
        if (/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(apiKey))
            throw new Error('API key could not be decrypted; save the key again.');
        if (format === 'google')
            headers['x-goog-api-key'] = apiKey;
        else if (format === 'anthropic')
            headers['x-api-key'] = apiKey;
        else
            headers.Authorization = `Bearer ${apiKey}`;
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
function supportsStreaming(_provider) {
    return true;
}
function getProviderUrl(baseUrl, modelName, isStream, translator) {
    if (typeof translator?.getGoogleApiUrl === 'function')
        return translator.getGoogleApiUrl(baseUrl, modelName, isStream);
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, '');
    const anthropicFormat = translator === anthropic;
    pathname = pathname.replace(/\/(?:chat\/completions|completions|messages)$/, '');
    if (!pathname)
        pathname = '/v1';
    pathname += anthropicFormat ? '/messages' : '/chat/completions';
    url.pathname = pathname;
    return url.toString();
}
//# sourceMappingURL=registry.js.map