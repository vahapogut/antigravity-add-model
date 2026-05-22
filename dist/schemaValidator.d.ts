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
export declare function validateCandidate(candidate: unknown): ValidationResult;
/**
 * Validates a Gemini GenerateContentResponse structure (top-level).
 */
export declare function validateGenerateContentResponse(response: unknown): ValidationResult;
/**
 * Validates a Cloud Code envelope (wrapper with response, traceId, metadata).
 */
export declare function validateCloudCodeEnvelope(envelope: unknown): ValidationResult;
/**
 * Validates a custom model configuration object.
 */
export declare function validateCustomModel(model: unknown): ValidationResult;
/**
 * Validates an array of custom model configurations.
 */
export declare function validateCustomModels(models: unknown): ValidationResult;
/**
 * Validates a Gemini request body (contents, generationConfig, tools, etc.)
 */
export declare function validateGenerateContentRequest(body: unknown): ValidationResult;
/**
 * Validates an OpenAI-style streaming chunk.
 */
export declare function validateOpenAiChunk(chunk: unknown): ValidationResult;
/**
 * Validates an Anthropic streaming event.
 */
export declare function validateAnthropicEvent(event: unknown): ValidationResult;
export {};
//# sourceMappingURL=schemaValidator.d.ts.map