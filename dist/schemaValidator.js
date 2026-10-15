"use strict";
/**
 * Schema Validator Module for Antigravity Proxy
 *
 * Validates API response schemas and data integrity for:
 * - Gemini GenerateContentResponse format
 * - Custom model configuration objects
 * - Streaming chunk structure
 *
 * This module provides runtime validation to catch malformed
 * responses before they reach the frontend, improving stability
 * and preventing cryptic UI errors.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCandidate = validateCandidate;
exports.validateGenerateContentResponse = validateGenerateContentResponse;
exports.validateCloudCodeEnvelope = validateCloudCodeEnvelope;
exports.validateCustomModel = validateCustomModel;
exports.validateCustomModels = validateCustomModels;
exports.validateGenerateContentRequest = validateGenerateContentRequest;
exports.validateOpenAiChunk = validateOpenAiChunk;
exports.validateAnthropicEvent = validateAnthropicEvent;
const providers_1 = require("./providers");
const modelUtils_1 = require("./proxy/modelUtils");
/**
 * Validates a Gemini candidate object structure.
 */
function validateCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return { valid: false, error: 'Candidate is null or not an object' };
    }
    const c = candidate;
    if (!c.content || typeof c.content !== 'object') {
        return { valid: false, error: 'Candidate missing content object' };
    }
    const content = c.content;
    if (!Array.isArray(content.parts)) {
        return { valid: false, error: 'Candidate content.parts is not an array' };
    }
    if (content.role && content.role !== 'model') {
        return { valid: false, error: `Unexpected candidate role: ${content.role}` };
    }
    if (c.finishReason && typeof c.finishReason !== 'string') {
        return { valid: false, error: 'finishReason must be a string' };
    }
    return { valid: true };
}
/**
 * Validates a Gemini GenerateContentResponse structure (top-level).
 */
function validateGenerateContentResponse(response) {
    if (!response || typeof response !== 'object') {
        return { valid: false, error: 'Response is null or not an object' };
    }
    const r = response;
    if (!Array.isArray(r.candidates)) {
        return { valid: false, error: 'Response candidates is not an array' };
    }
    if (r.candidates.length === 0) {
        return { valid: false, error: 'Response has no candidates' };
    }
    for (let i = 0; i < r.candidates.length; i++) {
        const candidateResult = validateCandidate(r.candidates[i]);
        if (!candidateResult.valid) {
            return { valid: false, error: `Candidate[${i}]: ${candidateResult.error}` };
        }
    }
    return { valid: true };
}
/**
 * Validates a Cloud Code envelope (wrapper with response, traceId, metadata).
 */
function validateCloudCodeEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') {
        return { valid: false, error: 'Envelope is null or not an object' };
    }
    const e = envelope;
    if (!e.response || typeof e.response !== 'object') {
        return { valid: false, error: 'Envelope missing response object' };
    }
    return validateGenerateContentResponse(e.response);
}
/**
 * Validates a custom model configuration object.
 */
function validateCustomModel(model) {
    if (!model || typeof model !== 'object') {
        return { valid: false, error: 'Model is null or not an object' };
    }
    const m = model;
    const required = ['name', 'provider', 'apiUrl'];
    for (const field of required) {
        if (!m[field] || typeof m[field] !== 'string') {
            return { valid: false, error: `Missing or invalid required field: ${field}` };
        }
    }
    const name = m.name;
    // Validate model name format: should start with "models/" or be a valid path
    if (!name.startsWith('models/') && !name.includes('/')) {
        return { valid: false, error: 'Model name must start with "models/"' };
    }
    const provider = m.provider;
    // Validate provider is one of the supported types
    const validProviders = providers_1.PROVIDERS.map((provider) => provider.id);
    if (!validProviders.includes(provider)) {
        return { valid: false, error: `Unsupported provider: ${provider}. Must be one of: ${validProviders.join(', ')}` };
    }
    const apiUrl = m.apiUrl;
    // Validate API URL format
    try {
        const url = new URL(apiUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, error: 'API URL must use http or https protocol' };
        }
        if (url.username || url.password) {
            return { valid: false, error: 'Use the API key or custom headers field instead of embedding credentials in the API URL' };
        }
        if ((0, providers_1.workersAiAccountPath)(apiUrl, provider) && m.apiFormat !== undefined && m.apiFormat !== 'openai') {
            return { valid: false, error: 'Cloudflare Workers AI requires the OpenAI compatible API format' };
        }
    }
    catch (e) {
        return { valid: false, error: `Invalid API URL: ${e.message}` };
    }
    // Validate optional fields
    if (m.externalModelName && typeof m.externalModelName !== 'string') {
        return { valid: false, error: 'externalModelName must be a string' };
    }
    if (m.displayName && typeof m.displayName !== 'string') {
        return { valid: false, error: 'displayName must be a string' };
    }
    if (m.apiKey && typeof m.apiKey !== 'string') {
        return { valid: false, error: 'apiKey must be a string' };
    }
    if (m.allowUnauthorized !== undefined && typeof m.allowUnauthorized !== 'boolean') {
        return { valid: false, error: 'allowUnauthorized must be a boolean' };
    }
    if (m.apiFormat !== undefined && !['openai', 'anthropic', 'google'].includes(m.apiFormat)) {
        return { valid: false, error: 'apiFormat must be openai, anthropic or google' };
    }
    if (m.provider === 'google-cloudcode' && m.apiFormat !== undefined && m.apiFormat !== 'google')
        return { valid: false, error: 'Google Cloud Code requires the google API format' };
    for (const field of ['enabled', 'rawUrl', 'gateway', 'supportsVision', 'supportsThinking', 'encryptedHeaders', 'encryptedGoogleAccounts']) {
        if (m[field] !== undefined && typeof m[field] !== 'boolean')
            return { valid: false, error: `${field} must be a boolean` };
    }
    for (const field of ['reasoningEffort', 'compactionReasoningEffort']) {
        if (m[field] !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(m[field])) {
            return { valid: false, error: `Invalid ${field}` };
        }
    }
    for (const field of ['contextWindow', 'maxOutputTokens', 'thinkingBudget', 'timeout', 'idleTimeout', 'retryBudgetMs', 'maxRetries']) {
        const value = m[field];
        const minimum = field === 'thinkingBudget' || field === 'maxRetries' ? 0 : 1;
        const maximum = field === 'maxRetries' ? 5 : ['timeout', 'idleTimeout', 'retryBudgetMs'].includes(field) ? 3600000 : 1000000000;
        if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)) {
            return { valid: false, error: `${field} must be an integer from ${minimum} to ${maximum}` };
        }
    }
    if (m.contextWindow !== undefined && m.maxOutputTokens !== undefined && Number(m.maxOutputTokens) >= Number(m.contextWindow)) {
        return { valid: false, error: 'maxOutputTokens must be smaller than contextWindow' };
    }
    if (m.compactionThresholdPercent !== undefined) {
        if (!Number.isSafeInteger(m.compactionThresholdPercent) || Number(m.compactionThresholdPercent) < 10 || Number(m.compactionThresholdPercent) > 90) {
            return { valid: false, error: 'compactionThresholdPercent must be an integer from 10 to 90' };
        }
        if (m.contextWindow === undefined) {
            return { valid: false, error: 'Set the actual contextWindow before configuring compactionThresholdPercent' };
        }
        const cap = (0, modelUtils_1.detectModelCapabilities)(m);
        if (cap.maxTokens - cap.maxOutputTokens - modelUtils_1.COMPACTION_TOKEN_RESERVE < modelUtils_1.NATIVE_DEFAULT_CHECKPOINT_THRESHOLD) {
            return { valid: false, error: 'IDE 2.5.5 requires at least 50000 input tokens after reserving the real model output limit and 1024 extra tokens before it can apply a custom compaction threshold; use the actual provider limits or leave the threshold unset' };
        }
        const threshold = Math.min(Math.floor(cap.maxTokens * Number(m.compactionThresholdPercent) / 100), cap.maxTokens - cap.maxOutputTokens - modelUtils_1.COMPACTION_TOKEN_RESERVE);
        if (threshold < 1024) {
            return { valid: false, error: 'Compaction needs at least 1024 input tokens after reserving the model output limit and 1024 extra tokens; increase contextWindow or lower maxOutputTokens to the actual provider limit' };
        }
    }
    if (m.fallbackModels !== undefined && (!Array.isArray(m.fallbackModels) || m.fallbackModels.length > 20 || m.fallbackModels.some((value) => typeof value !== 'string' || !value.trim()))) {
        return { valid: false, error: 'fallbackModels must contain up to 20 saved model names' };
    }
    if (m.circuitBreaker !== undefined) {
        if (!m.circuitBreaker || typeof m.circuitBreaker !== 'object' || Array.isArray(m.circuitBreaker))
            return { valid: false, error: 'circuitBreaker must be an object' };
        const options = m.circuitBreaker;
        if (options.enabled !== undefined && typeof options.enabled !== 'boolean')
            return { valid: false, error: 'circuitBreaker.enabled must be boolean' };
        for (const field of ['failureThreshold', 'cooldownMs']) {
            if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || Number(options[field]) < 1 || Number(options[field]) > 3600000)) {
                return { valid: false, error: `circuitBreaker.${field} must be a positive integer up to 3600000` };
            }
        }
    }
    if (m.customHeaders !== undefined) {
        if (!m.customHeaders || typeof m.customHeaders !== 'object' || Array.isArray(m.customHeaders))
            return { valid: false, error: 'customHeaders must be an object' };
        for (const [key, value] of Object.entries(m.customHeaders)) {
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(host|content-length|connection|transfer-encoding)$/i.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) {
                return { valid: false, error: 'customHeaders contains a reserved or invalid header' };
            }
        }
    }
    if (m.extraBody !== undefined) {
        if (!m.extraBody || typeof m.extraBody !== 'object' || Array.isArray(m.extraBody))
            return { valid: false, error: 'extraBody must be an object' };
        const reserved = ['model', 'messages', 'contents', 'system', 'systemInstruction', 'tools', 'stream'];
        for (const key of Object.keys(m.extraBody)) {
            if (reserved.includes(key))
                return { valid: false, error: `extraBody cannot override ${key}` };
        }
    }
    if (m.googleProject !== undefined && typeof m.googleProject !== 'string')
        return { valid: false, error: 'googleProject must be a string' };
    if (m.googleAccounts !== undefined) {
        if (!Array.isArray(m.googleAccounts) || m.googleAccounts.length > 50)
            return { valid: false, error: 'googleAccounts must be an array with at most 50 accounts' };
        const ids = new Set();
        for (const entry of m.googleAccounts) {
            if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id))
                return { valid: false, error: 'Each Google account needs a unique id' };
            ids.add(entry.id);
            for (const field of ['label', 'refreshToken', 'accessToken', 'clientId', 'clientSecret', 'project', 'email']) {
                if (entry[field] !== undefined && typeof entry[field] !== 'string')
                    return { valid: false, error: `Google account ${field} must be a string` };
            }
            if (entry.authMode !== undefined && !['custom', 'antigravity'].includes(entry.authMode))
                return { valid: false, error: 'Google account authMode must be custom or antigravity' };
            if (entry.cloudCodeEndpoint !== undefined && !['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com'].includes(entry.cloudCodeEndpoint))
                return { valid: false, error: 'Google account cloudCodeEndpoint must be an official Cloud Code origin' };
            if (entry.expiresAt !== undefined && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0))
                return { valid: false, error: 'Google account expiresAt must be a timestamp in milliseconds' };
            if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
                return { valid: false, error: 'Google account enabled must be a boolean' };
        }
    }
    if (m.googlePool !== undefined) {
        if (!m.googlePool || typeof m.googlePool !== 'object' || Array.isArray(m.googlePool))
            return { valid: false, error: 'googlePool must be an object' };
        const options = m.googlePool;
        if (options.strategy !== undefined && !['round-robin', 'least-loaded', 'quota', 'adaptive'].includes(options.strategy))
            return { valid: false, error: 'Invalid Google pool strategy' };
        for (const field of ['maxConcurrency', 'cooldownMs']) {
            const maximum = field === 'maxConcurrency' ? 100 : 3600000;
            if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || Number(options[field]) < 1 || Number(options[field]) > maximum))
                return { valid: false, error: `googlePool.${field} must be a positive integer up to ${maximum}` };
        }
    }
    return { valid: true };
}
/**
 * Validates an array of custom model configurations.
 */
function validateCustomModels(models) {
    if (!Array.isArray(models)) {
        return { valid: false, error: 'Models must be an array' };
    }
    for (let i = 0; i < models.length; i++) {
        const result = validateCustomModel(models[i]);
        if (!result.valid) {
            return { valid: false, error: `Model[${i}]: ${result.error}` };
        }
    }
    return { valid: true };
}
/**
 * Validates a Gemini request body (contents, generationConfig, tools, etc.)
 */
function validateGenerateContentRequest(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Body is null or not an object' };
    }
    const b = body;
    if (!Array.isArray(b.contents) || b.contents.length === 0) {
        return { valid: false, error: 'Request must have non-empty contents array' };
    }
    if (b.systemInstruction && typeof b.systemInstruction !== 'object') {
        return { valid: false, error: 'systemInstruction must be an object' };
    }
    if (b.generationConfig && typeof b.generationConfig !== 'object') {
        return { valid: false, error: 'generationConfig must be an object' };
    }
    if (b.tools && !Array.isArray(b.tools)) {
        return { valid: false, error: 'tools must be an array' };
    }
    return { valid: true };
}
/**
 * Validates an OpenAI-style streaming chunk.
 */
function validateOpenAiChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') {
        return { valid: false, error: 'Chunk is null or not an object' };
    }
    const c = chunk;
    if (!Array.isArray(c.choices)) {
        return { valid: false, error: 'Chunk choices is not an array' };
    }
    return { valid: true };
}
/**
 * Validates an Anthropic streaming event.
 */
function validateAnthropicEvent(event) {
    if (!event || typeof event !== 'object') {
        return { valid: false, error: 'Event is null or not an object' };
    }
    const e = event;
    if (!e.type || typeof e.type !== 'string') {
        return { valid: false, error: 'Event missing type field' };
    }
    const validTypes = [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
        'ping',
        'error',
    ];
    if (!validTypes.includes(e.type)) {
        return { valid: false, error: `Unknown event type: ${e.type}` };
    }
    return { valid: true };
}
//# sourceMappingURL=schemaValidator.js.map