"use strict";
/**
 * Google AI Studio Translator.
 *
 * Google AI Studio speaks Gemini format natively, so request/response
 * translation is a passthrough. The main addition is SSE streaming chunk
 * parsing and proper endpoint URL handling.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapGeminiToGoogle = mapGeminiToGoogle;
exports.mapGoogleToGemini = mapGoogleToGemini;
exports.mapGoogleChunkToGemini = mapGoogleChunkToGemini;
exports.getGoogleApiUrl = getGoogleApiUrl;
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Request Translation (Passthrough) ────────────────────────────────────
/**
 * Google AI Studio uses the same Gemini format — just pass through.
 * The caller handles URL routing (streamGenerateContent vs generateContent).
 */
function mapGeminiToGoogle(geminiBody, modelName) {
    // Ensure the external model name is set
    const body = { ...geminiBody };
    if (modelName && !body.model) {
        body.model = modelName;
    }
    return body;
}
// ─── Response Translation (Passthrough) ───────────────────────────────────
/**
 * Google AI Studio returns Gemini-format responses directly.
 * Just pass through — the proxy wraps it in the Cloud Code envelope.
 */
function mapGoogleToGemini(googleRes, _modelName) {
    // Google AI Studio response is already in Gemini format
    // Wrapped by caller in { response, traceId, metadata }
    return googleRes;
}
// ─── Streaming Chunk Translation ──────────────────────────────────────────
/**
 * Parse a Google AI Studio SSE streaming chunk into a Gemini candidate.
 *
 * Google AI Studio streams JSON chunks like:
 *   {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},...}]}
 *
 * Each chunk contains complete candidate objects (not deltas).
 */
function mapGoogleChunkToGemini(chunk, _modelName) {
    if (!chunk || typeof chunk !== 'object')
        return null;
    const data = chunk;
    // Extract first candidate
    if (!data.candidates || data.candidates.length === 0)
        return null;
    const candidate = data.candidates[0];
    // Check if there's actual content to emit
    const parts = candidate.content?.parts;
    if (!parts || parts.length === 0) {
        // Might be a final chunk with just finishReason
        if (candidate.finishReason) {
            return {
                content: { parts: [], role: 'model' },
                finishReason: candidate.finishReason,
                index: candidate.index ?? 0,
            };
        }
        return null;
    }
    return {
        content: candidate.content,
        finishReason: candidate.finishReason || 'OTHER',
        index: candidate.index ?? 0,
        safetyRatings: candidate.safetyRatings,
    };
}
// ─── URL Helpers ──────────────────────────────────────────────────────────
/**
 * Constructs the correct Google AI Studio endpoint URL based on streaming mode.
 *
 * Google AI Studio uses different endpoints:
 *   - Non-streaming: :generateContent
 *   - Streaming:     :streamGenerateContent
 *
 * If the user's URL already contains one of these endpoints, it's kept as-is.
 */
function getGoogleApiUrl(baseUrl, modelName, isStream) {
    let url = baseUrl;
    // If the URL doesn't already specify a method, append one
    if (!url.includes(':generateContent') && !url.includes(':streamGenerateContent')) {
        // Strip trailing slash if present
        url = url.replace(/\/$/, '');
        // Check if the URL ends with the model path (e.g. /models/gemini-1.5-pro)
        const modelPathPattern = /\/models\/([^\/]+)$/;
        const modelMatch = modelPathPattern.exec(url);
        if (modelMatch) {
            // URL like .../v1beta/models/gemini-1.5-pro → append :method
            const method = isStream ? ':streamGenerateContent' : ':generateContent';
            url += method;
        }
        else if (modelName) {
            // Append full path with model name
            const method = isStream ? ':streamGenerateContent' : ':generateContent';
            url += `models/${modelName}${method}`;
        }
        else {
            // Fallback: assume the URL is already complete
            electron_log_1.default.warn('[GoogleTranslator] Could not determine model name for URL construction');
        }
    }
    return url;
}
//# sourceMappingURL=google.js.map