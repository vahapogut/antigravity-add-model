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

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a Gemini candidate object structure.
 */
export function validateCandidate(candidate: unknown): ValidationResult {
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, error: 'Candidate is null or not an object' };
  }
  const c = candidate as Record<string, unknown>;
  if (!c.content || typeof c.content !== 'object') {
    return { valid: false, error: 'Candidate missing content object' };
  }
  const content = c.content as Record<string, unknown>;
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
export function validateGenerateContentResponse(response: unknown): ValidationResult {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response is null or not an object' };
  }
  const r = response as Record<string, unknown>;
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
export function validateCloudCodeEnvelope(envelope: unknown): ValidationResult {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, error: 'Envelope is null or not an object' };
  }
  const e = envelope as Record<string, unknown>;
  if (!e.response || typeof e.response !== 'object') {
    return { valid: false, error: 'Envelope missing response object' };
  }
  return validateGenerateContentResponse(e.response);
}

/**
 * Validates a custom model configuration object.
 */
export function validateCustomModel(model: unknown): ValidationResult {
  if (!model || typeof model !== 'object') {
    return { valid: false, error: 'Model is null or not an object' };
  }

  const m = model as Record<string, unknown>;
  const required = ['name', 'provider', 'apiUrl'];
  for (const field of required) {
    if (!m[field] || typeof m[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  const name = m.name as string;
  // Validate model name format: should start with "models/" or be a valid path
  if (!name.startsWith('models/') && !name.includes('/')) {
    return { valid: false, error: 'Model name must start with "models/"' };
  }

  const provider = m.provider as string;
  // Validate provider is one of the supported types
  const validProviders = ['openai', 'anthropic', 'google', 'ollama', 'custom'];
  if (!validProviders.includes(provider)) {
    return { valid: false, error: `Unsupported provider: ${provider}. Must be one of: ${validProviders.join(', ')}` };
  }

  const apiUrl = m.apiUrl as string;
  // Validate API URL format
  try {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'API URL must use http or https protocol' };
    }
  } catch (e) {
    return { valid: false, error: `Invalid API URL: ${(e as Error).message}` };
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

  return { valid: true };
}

/**
 * Validates an array of custom model configurations.
 */
export function validateCustomModels(models: unknown): ValidationResult {
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
export function validateGenerateContentRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Body is null or not an object' };
  }
  const b = body as Record<string, unknown>;
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
export function validateOpenAiChunk(chunk: unknown): ValidationResult {
  if (!chunk || typeof chunk !== 'object') {
    return { valid: false, error: 'Chunk is null or not an object' };
  }
  const c = chunk as Record<string, unknown>;
  if (!Array.isArray(c.choices)) {
    return { valid: false, error: 'Chunk choices is not an array' };
  }
  return { valid: true };
}

/**
 * Validates an Anthropic streaming event.
 */
export function validateAnthropicEvent(event: unknown): ValidationResult {
  if (!event || typeof event !== 'object') {
    return { valid: false, error: 'Event is null or not an object' };
  }
  const e = event as Record<string, unknown>;
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
  if (!validTypes.includes(e.type as string)) {
    return { valid: false, error: `Unknown event type: ${e.type}` };
  }
  return { valid: true };
}
