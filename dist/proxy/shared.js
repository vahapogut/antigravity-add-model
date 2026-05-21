"use strict";
/**
 * Shared state module for proxy orchestration.
 * Extracted from proxy.js to decouple translators from main orchestration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateTimestamps = exports.translatedToolCalls = exports.activeStreamContexts = exports.modelReasoningContent = exports.modelToolCallIds = void 0;
exports.touchStateTimestamp = touchStateTimestamp;
exports.startCleanupInterval = startCleanupInterval;
exports.stopCleanupInterval = stopCleanupInterval;
// ─── State ────────────────────────────────────────────────────────────────
/** modelName → { "functionName": "original_tool_call_id" } */
exports.modelToolCallIds = new Map();
/** modelName → preserved reasoning_content from previous turn */
exports.modelReasoningContent = new Map();
/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
exports.activeStreamContexts = new Map();
/** toolCallId → { originalName, translatedName, cmd, cwd } */
exports.translatedToolCalls = new Map();
/** State entry timestamps for periodic cleanup */
exports.stateTimestamps = {
    streamCtx: new Map(),
    toolCallIds: new Map(),
    translatedCalls: new Map(),
    reasoning: new Map(),
};
// ─── Helpers ──────────────────────────────────────────────────────────────
function touchStateTimestamp(map, key) {
    map.set(key, Date.now());
}
// ─── Periodic Cleanup (managed lifecycle) ─────────────────────────────────
let cleanupInterval = null;
function startCleanupInterval() {
    if (cleanupInterval)
        return; // already running
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        const STREAM_TTL = 600000; // 10 minutes for active stream contexts
        const TOOL_TTL = 1800000; // 30 minutes for tool call IDs & reasoning
        for (const [key, ts] of exports.stateTimestamps.streamCtx) {
            if (now - ts > STREAM_TTL) {
                exports.activeStreamContexts.delete(key);
                exports.stateTimestamps.streamCtx.delete(key);
            }
        }
        for (const [key, ts] of exports.stateTimestamps.toolCallIds) {
            if (now - ts > TOOL_TTL) {
                exports.modelToolCallIds.delete(key);
                exports.stateTimestamps.toolCallIds.delete(key);
            }
        }
        for (const [key, ts] of exports.stateTimestamps.translatedCalls) {
            if (now - ts > TOOL_TTL) {
                exports.translatedToolCalls.delete(key);
                exports.stateTimestamps.translatedCalls.delete(key);
            }
        }
        for (const [key, ts] of exports.stateTimestamps.reasoning) {
            if (now - ts > TOOL_TTL) {
                exports.modelReasoningContent.delete(key);
                exports.stateTimestamps.reasoning.delete(key);
            }
        }
    }, 300000);
}
function stopCleanupInterval() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}
// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();
//# sourceMappingURL=shared.js.map