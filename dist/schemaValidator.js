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

/**
 * Validates a Gemini candidate object structure.
 */
function validateCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return { valid: false, error: 'Candidate is null or not an object' };
    }
    if (!candidate.content || typeof candidate.content !== 'object') {
        return { valid: false, error: 'Candidate missing content object' };
    }
    if (!Array.isArray(candidate.content.parts)) {
        return { valid: false, error: 'Candidate content.parts is not an array' };
    }
    if (candidate.content.role && candidate.content.role !== 'model') {
        return { valid: false, error: `Unexpected candidate role: ${candidate.content.role}` };
    }
    if (candidate.finishReason && typeof candidate.finishReason !== 'string') {
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
    if (!Array.isArray(response.candidates)) {
        return { valid: false, error: 'Response candidates is not an array' };
    }
    if (response.candidates.length === 0) {
        return { valid: false, error: 'Response has no candidates' };
    }
    for (let i = 0; i < response.candidates.length; i++) {
        const candidateResult = validateCandidate(response.candidates[i]);
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
    if (!envelope.response || typeof envelope.response !== 'object') {
        return { valid: false, error: 'Envelope missing response object' };
    }
    return validateGenerateContentResponse(envelope.response);
}

/**
 * Validates a custom model configuration object.
 */
function validateCustomModel(model) {
    if (!model || typeof model !== 'object') {
        return { valid: false, error: 'Model is null or not an object' };
    }

    const required = ['name', 'provider', 'apiUrl'];
    for (const field of required) {
        if (!model[field] || typeof model[field] !== 'string') {
            return { valid: false, error: `Missing or invalid required field: ${field}` };
        }
    }

    // Validate model name format: should start with "models/" or be a valid path
    if (!model.name.startsWith('models/') && !model.name.includes('/')) {
        return { valid: false, error: 'Model name must start with "models/"' };
    }

    // Validate provider is one of the supported types
    const validProviders = ['openai', 'anthropic', 'google', 'ollama', 'custom'];
    if (!validProviders.includes(model.provider)) {
        return { valid: false, error: `Unsupported provider: ${model.provider}. Must be one of: ${validProviders.join(', ')}` };
    }

    // Validate API URL format
    try {
        const url = new URL(model.apiUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, error: 'API URL must use http or https protocol' };
        }
    } catch (e) {
        return { valid: false, error: `Invalid API URL: ${e.message}` };
    }

    // Validate optional fields
    if (model.externalModelName && typeof model.externalModelName !== 'string') {
        return { valid: false, error: 'externalModelName must be a string' };
    }
    if (model.displayName && typeof model.displayName !== 'string') {
        return { valid: false, error: 'displayName must be a string' };
    }
    if (model.apiKey && typeof model.apiKey !== 'string') {
        return { valid: false, error: 'apiKey must be a string' };
    }
    if (model.allowUnauthorized !== undefined && typeof model.allowUnauthorized !== 'boolean') {
        return { valid: false, error: 'allowUnauthorized must be a boolean' };
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
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        return { valid: false, error: 'Request must have non-empty contents array' };
    }
    if (body.systemInstruction && typeof body.systemInstruction !== 'object') {
        return { valid: false, error: 'systemInstruction must be an object' };
    }
    if (body.generationConfig && typeof body.generationConfig !== 'object') {
        return { valid: false, error: 'generationConfig must be an object' };
    }
    if (body.tools && !Array.isArray(body.tools)) {
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
    if (!Array.isArray(chunk.choices)) {
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
    if (!event.type || typeof event.type !== 'string') {
        return { valid: false, error: 'Event missing type field' };
    }
    const validTypes = [
        'message_start', 'content_block_start', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop',
        'ping', 'error'
    ];
    if (!validTypes.includes(event.type)) {
        return { valid: false, error: `Unknown event type: ${event.type}` };
    }
    return { valid: true };
}

module.exports = {
    validateCandidate,
    validateGenerateContentResponse,
    validateCloudCodeEnvelope,
    validateCustomModel,
    validateCustomModels,
    validateGenerateContentRequest,
    validateOpenAiChunk,
    validateAnthropicEvent
};
