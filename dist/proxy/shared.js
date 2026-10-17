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
exports.stateTimestamps = exports.translatedToolCalls = exports.activeStreamContexts = exports.modelReasoningContent = exports.modelToolCallIds = void 0;
exports.touchStateTimestamp = touchStateTimestamp;
exports.startCleanupInterval = startCleanupInterval;
exports.stopCleanupInterval = stopCleanupInterval;
exports.recordOfficialQuota = recordOfficialQuota;
exports.getOfficialQuota = getOfficialQuota;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
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
    // Importing translator/model-management helpers must not keep a CLI process alive.
    cleanupInterval.unref?.();
}
function stopCleanupInterval() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}
// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();
let latestOfficialQuota;
let latestOfficialQuotaEmail;
let latestOfficialQuotaAt = 0;
function getOfficialQuotaPath() {
    const home = process.env.USERPROFILE || process.env.HOME || (typeof os !== 'undefined' ? os.homedir() : '');
    return path.join(home, '.gemini', 'antigravity', '.official_quota.json');
}
function recordOfficialQuota(data, email) {
    if (data && typeof data === 'object') {
        latestOfficialQuota = data;
        const extractedEmail = email ||
            (typeof data.userEmail === 'string'
                ? data.userEmail
                : typeof data.user?.email === 'string'
                    ? data.user.email
                    : undefined);
        if (extractedEmail)
            latestOfficialQuotaEmail = extractedEmail.trim().toLowerCase();
        latestOfficialQuotaAt = Date.now();
        try {
            const p = getOfficialQuotaPath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify({
                updatedAt: latestOfficialQuotaAt,
                email: latestOfficialQuotaEmail,
                data: latestOfficialQuota,
            }), 'utf8');
        }
        catch { }
    }
}
function getOfficialQuota(filterEmail) {
    const normalizedFilter = filterEmail?.trim().toLowerCase();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (latestOfficialQuota && Date.now() - latestOfficialQuotaAt < ONE_DAY) {
        if (!normalizedFilter || (latestOfficialQuotaEmail && latestOfficialQuotaEmail === normalizedFilter)) {
            return latestOfficialQuota;
        }
    }
    try {
        const p = getOfficialQuotaPath();
        if (fs.existsSync(p)) {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.data) {
                if (Date.now() - (parsed.updatedAt || 0) < ONE_DAY) {
                    const fileEmail = (parsed.email || '').trim().toLowerCase();
                    if (!normalizedFilter || (fileEmail && fileEmail === normalizedFilter)) {
                        latestOfficialQuota = parsed.data;
                        latestOfficialQuotaEmail = fileEmail || undefined;
                        latestOfficialQuotaAt = parsed.updatedAt || Date.now();
                        return parsed.data;
                    }
                }
            }
        }
    }
    catch { }
    return undefined;
}
//# sourceMappingURL=shared.js.map