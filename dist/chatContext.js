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
exports.findLatestConversationId = findLatestConversationId;
exports.findConversationIdByTitle = findConversationIdByTitle;
exports.getChatContextUsage = getChatContextUsage;
exports.normalizeModelName = normalizeModelName;
exports.cleanModelSlug = cleanModelSlug;
exports.resolveModelContextLimit = resolveModelContextLimit;
exports.fetchContextLimitFromApi = fetchContextLimitFromApi;
exports.updateCustomModelContextWindow = updateCustomModelContextWindow;
exports.formatTokenCount = formatTokenCount;
exports.formatContextUnit = formatContextUnit;
exports.formatContextTooltip = formatContextTooltip;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function findLatestConversationId(brainDir) {
    try {
        if (!fs.existsSync(brainDir))
            return null;
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        let newestId = null;
        let newestMtime = 0;
        for (const entry of entries) {
            if (!entry.isDirectory() || !UUID_REGEX.test(entry.name))
                continue;
            const transcriptFile = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
            try {
                const stat = fs.statSync(transcriptFile);
                if (stat.mtimeMs > newestMtime) {
                    newestMtime = stat.mtimeMs;
                    newestId = entry.name;
                }
            }
            catch {
            }
        }
        return newestId;
    }
    catch {
        return null;
    }
}
function findConversationIdByTitle(title, customDbPath) {
    if (!title || typeof title !== 'string')
        return null;
    const cleanTitle = title.trim();
    if (!cleanTitle)
        return null;
    const dbPath = customDbPath || path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
    try {
        if (!fs.existsSync(dbPath))
            return null;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqlite = require('node:sqlite');
        if (!sqlite || typeof sqlite.DatabaseSync !== 'function')
            return null;
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
            const stmt = db.prepare('SELECT conversation_id FROM conversation_summaries WHERE title = ? ORDER BY last_modified_time DESC LIMIT 1');
            const row = stmt.get(cleanTitle);
            if (row && typeof row.conversation_id === 'string' && UUID_REGEX.test(row.conversation_id)) {
                return row.conversation_id;
            }
        }
        finally {
            db.close();
        }
    }
    catch {
    }
    return null;
}
function getChatContextUsage(convId, overrideBrainDir, options) {
    const brainDir = overrideBrainDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    let targetId = convId && UUID_REGEX.test(convId) ? convId : undefined;
    if (!targetId && options?.title) {
        targetId = findConversationIdByTitle(options.title) || undefined;
    }
    if (!targetId && options?.fallbackToLatest) {
        targetId = findLatestConversationId(brainDir) || undefined;
    }
    const fallback = {
        conversationId: targetId || '',
        currentTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
    };
    if (!targetId)
        return fallback;
    const transcriptPath = path.join(brainDir, targetId, '.system_generated', 'logs', 'transcript.jsonl');
    try {
        if (!fs.existsSync(transcriptPath))
            return fallback;
        const stat = fs.statSync(transcriptPath);
        if (stat.size === 0)
            return fallback;
        let fileContent;
        if (stat.size <= 2 * 1024 * 1024) {
            fileContent = fs.readFileSync(transcriptPath, 'utf8');
        }
        else {
            const readSize = Math.min(stat.size, 512 * 1024);
            const buffer = Buffer.alloc(readSize);
            const fd = fs.openSync(transcriptPath, 'r');
            try {
                fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
            }
            finally {
                fs.closeSync(fd);
            }
            fileContent = buffer.toString('utf8');
        }
        const lines = fileContent.split('\n');
        let lastModelInputTokens;
        let lastModelCacheTokens;
        let lastModelOutputTokens;
        let postCompactionChars = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line)
                continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'CHECKPOINT' ||
                    (typeof entry.content === 'string' && entry.content.includes('Resuming from a compaction'))) {
                    if (entry.content)
                        postCompactionChars += entry.content.length;
                    break;
                }
                if (lastModelInputTokens === undefined &&
                    entry.source === 'MODEL' &&
                    typeof entry.input_tokens === 'number' &&
                    entry.input_tokens > 0) {
                    lastModelInputTokens = entry.input_tokens;
                    lastModelCacheTokens = typeof entry.cache_read_tokens === 'number' ? entry.cache_read_tokens : 0;
                    lastModelOutputTokens = typeof entry.output_tokens === 'number' ? entry.output_tokens : 0;
                }
                if (typeof entry.content === 'string') {
                    postCompactionChars += entry.content.length;
                }
                if (typeof entry.thinking === 'string') {
                    postCompactionChars += entry.thinking.length;
                }
                if (entry.tool_calls && Array.isArray(entry.tool_calls)) {
                    postCompactionChars += JSON.stringify(entry.tool_calls).length;
                }
            }
            catch {
            }
        }
        if (lastModelInputTokens !== undefined && lastModelInputTokens > 0) {
            const fresh = lastModelInputTokens;
            const cached = lastModelCacheTokens || 0;
            const out = lastModelOutputTokens || 0;
            const input = fresh + cached;
            return {
                conversationId: targetId,
                currentTokens: input + out,
                inputTokens: input,
                outputTokens: out,
                cacheReadTokens: cached,
            };
        }
        if (postCompactionChars > 0) {
            const estimatedTokens = Math.max(1, Math.round(postCompactionChars / 3.8));
            return {
                conversationId: targetId,
                currentTokens: estimatedTokens,
                inputTokens: estimatedTokens,
                outputTokens: 0,
                cacheReadTokens: 0,
            };
        }
    }
    catch {
    }
    return fallback;
}
function normalizeModelName(str) {
    if (!str || typeof str !== 'string')
        return '';
    return str
        .replace(/[\u25be\u25b2\u25bc\u25c2\u25b8\u25c0\u25b6\^]/g, ' ')
        .replace(/\s+[vV]\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
function cleanModelSlug(s) {
    if (!s || typeof s !== 'string')
        return '';
    return s
        .toLowerCase()
        .replace(/[\u25be\u25b2\u25bc\u25c2\u25b8\u25c0\u25b6\^]/g, ' ')
        .replace(/\s+[vV]\s*$/, '')
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/^models\//, '')
        .replace(/^[^/]+\//, '')
        .replace(/[-_/]free\b/g, '')
        .replace(/\bfree[-_/]/g, '')
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function resolveModelContextLimit(modelName, customModels) {
    if (!modelName)
        return undefined;
    const clean = normalizeModelName(modelName);
    if (!clean)
        return undefined;
    let modelsList = customModels;
    if ((!modelsList || modelsList.length === 0) && typeof process !== 'undefined' && process.versions?.node) {
        try {
            const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
            if (fs.existsSync(dbPath)) {
                const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                if (Array.isArray(parsed?.models)) {
                    modelsList = parsed.models;
                }
            }
        }
        catch {
        }
    }
    if (modelsList && Array.isArray(modelsList)) {
        const slug = cleanModelSlug(clean);
        for (const cm of modelsList) {
            const cmName = normalizeModelName(cm.name || '');
            const cmDisplay = normalizeModelName(cm.displayName || '');
            const cmExt = normalizeModelName(cm.externalModelName || '');
            const cmSlug = cleanModelSlug(cm.displayName || cm.name || '');
            const exact = (cmDisplay && clean === cmDisplay) ||
                (cmName && clean === cmName) ||
                (cmExt && clean === cmExt) ||
                (slug && cmSlug && slug === cmSlug);
            const fuzzy = (cmDisplay.length >= 4 && (clean.includes(cmDisplay) || cmDisplay.includes(clean))) ||
                (cmExt.length >= 4 && (clean.includes(cmExt) || cmExt.includes(clean))) ||
                (slug.length >= 4 && cmSlug.length >= 4 && (slug.includes(cmSlug) || cmSlug.includes(slug)));
            if (exact || fuzzy) {
                if (typeof cm.contextWindow === 'number' && cm.contextWindow > 0)
                    return cm.contextWindow;
                if (typeof cm.nativeContextWindow === 'number' && cm.nativeContextWindow > 0)
                    return cm.nativeContextWindow;
            }
        }
    }
    if (clean.includes('gemini')) {
        if (clean.includes('pro') || clean.includes('1.5-pro') || clean.includes('2.5-pro')) {
            return 2000000;
        }
        if (clean.includes('flash') || clean.includes('1.5-flash') || clean.includes('2.0-flash') || clean.includes('2.5-flash') || clean.includes('3.8-flash')) {
            return 1000000;
        }
        if (clean.includes('1.0-pro') || clean.includes('1.0 pro')) {
            return 32000;
        }
        return 1000000;
    }
    if (clean.includes('claude') || clean.includes('sonnet') || clean.includes('opus') || clean.includes('haiku')) {
        return 200000;
    }
    if (/\bo[13](?:-mini|-preview)?\b/.test(clean)) {
        return 200000;
    }
    if (clean.includes('gpt-4') || clean.includes('gpt4') || clean.includes('chatgpt')) {
        return 128000;
    }
    if (clean.includes('deepseek')) {
        return 64000;
    }
    if (clean.includes('mistral') || clean.includes('codestral') || clean.includes('llama') || clean.includes('qwen')) {
        return 128000;
    }
    return undefined;
}
let modelsDevApiCache = null;
let modelsDevApiCacheTime = 0;
async function fetchContextLimitFromApi(targetSlug) {
    const cleanTarget = targetSlug.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!cleanTarget)
        return undefined;
    const now = Date.now();
    if (!modelsDevApiCache || now - modelsDevApiCacheTime > 300000) {
        try {
            const res = await fetch('https://models.dev/api.json?type=all', { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                modelsDevApiCache = await res.json();
                modelsDevApiCacheTime = now;
            }
        }
        catch {
            return undefined;
        }
    }
    if (!modelsDevApiCache || typeof modelsDevApiCache !== 'object')
        return undefined;
    let substringMatch;
    for (const provider of Object.values(modelsDevApiCache)) {
        if (!provider || typeof provider !== 'object' || !provider.models)
            continue;
        const models = provider.models;
        for (const [mId, mObj] of Object.entries(models)) {
            if (!mObj || typeof mObj !== 'object')
                continue;
            const m = mObj;
            const context = m.limit?.context;
            if (typeof context !== 'number' || context <= 0)
                continue;
            const cleanId = mId.toLowerCase().replace(/[^a-z0-9]+/g, '');
            const cleanName = String(m.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
            const cleanCanon = String(m.canonical_model_id || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (cleanId === cleanTarget || cleanName === cleanTarget || cleanCanon === cleanTarget) {
                return context;
            }
            if (!substringMatch &&
                cleanTarget.length >= 4 &&
                (cleanId.includes(cleanTarget) || cleanName.includes(cleanTarget) || cleanCanon.includes(cleanTarget))) {
                substringMatch = context;
            }
        }
    }
    return substringMatch;
}
function updateCustomModelContextWindow(modelName, contextWindow, customDbPath) {
    const dbPath = customDbPath || path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
    try {
        if (!fs.existsSync(dbPath))
            return false;
        const raw = fs.readFileSync(dbPath, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data?.models))
            return false;
        const clean = normalizeModelName(modelName);
        const slug = cleanModelSlug(clean);
        let updated = false;
        for (const cm of data.models) {
            const cmName = normalizeModelName(cm.name || '');
            const cmDisplay = normalizeModelName(cm.displayName || '');
            const cmExt = normalizeModelName(cm.externalModelName || '');
            const cmSlug = cleanModelSlug(cm.displayName || cm.name || '');
            const match = (cmDisplay && clean === cmDisplay) ||
                (cmName && clean === cmName) ||
                (cmExt && clean === cmExt) ||
                (slug && cmSlug && slug === cmSlug) ||
                (slug && cmExt && slug === cleanModelSlug(cmExt));
            if (match && cm.contextWindow !== contextWindow) {
                cm.contextWindow = contextWindow;
                updated = true;
            }
        }
        if (updated) {
            fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        }
    }
    catch {
    }
    return false;
}
function formatTokenCount(tokens) {
    if (typeof tokens !== 'number' || isNaN(tokens) || tokens < 0)
        return '0';
    return Math.round(tokens).toLocaleString('en-US');
}
function formatContextUnit(tokens) {
    if (typeof tokens !== 'number' || isNaN(tokens) || tokens <= 0)
        return '0';
    if (tokens >= 1000000) {
        const m = tokens / 1000000;
        return (Number.isInteger(m) ? m.toString() : m.toFixed(1).replace(/\.0$/, '')) + 'M';
    }
    const k = tokens / 1000;
    return (Number.isInteger(k) ? k.toString() : Math.round(k).toString()) + 'k';
}
function formatContextTooltip(currentTokens, maxTokens) {
    const formattedCurrent = formatTokenCount(currentTokens);
    if (typeof maxTokens === 'number' && maxTokens > 0) {
        const formattedMax = formatContextUnit(maxTokens);
        const pct = Math.round((currentTokens / maxTokens) * 1000) / 10;
        return `Context: ${formattedCurrent} / ${formattedMax} (${pct}%)`;
    }
    return `Context: ${formattedCurrent} / Unknown`;
}
//# sourceMappingURL=chatContext.js.map