import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ChatContextUsage {
  conversationId: string;
  currentTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ModelContextLookupEntry {
  name?: string;
  displayName?: string;
  externalModelName?: string;
  contextWindow?: number;
  nativeContextWindow?: number;
}

export interface ChatContextOptions {
  title?: string;
  fallbackToLatest?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findLatestConversationId(brainDir: string): string | null {
  try {
    if (!fs.existsSync(brainDir)) return null;
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let newestId: string | null = null;
    let newestMtime = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) continue;
      const transcriptFile = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = fs.statSync(transcriptFile);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestId = entry.name;
        }
      } catch {
      }
    }
    return newestId;
  } catch {
    return null;
  }
}

export function findConversationIdByTitle(title?: string, customDbPath?: string): string | null {
  if (!title || typeof title !== 'string') return null;
  const cleanTitle = title.trim();
  if (!cleanTitle) return null;
  const dbPath = customDbPath || path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
  try {
    if (!fs.existsSync(dbPath)) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return null;
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        'SELECT conversation_id FROM conversation_summaries WHERE title = ? ORDER BY last_modified_time DESC LIMIT 1',
      );
      const row = stmt.get(cleanTitle) as { conversation_id?: string } | undefined;
      if (row && typeof row.conversation_id === 'string' && UUID_REGEX.test(row.conversation_id)) {
        return row.conversation_id;
      }
    } finally {
      db.close();
    }
  } catch {
  }
  return null;
}

export function getChatContextUsage(
  convId?: string,
  overrideBrainDir?: string,
  options?: ChatContextOptions,
): ChatContextUsage {
  const brainDir = overrideBrainDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  let targetId = convId && UUID_REGEX.test(convId) ? convId : undefined;

  if (!targetId && options?.title) {
    targetId = findConversationIdByTitle(options.title) || undefined;
  }
  if (!targetId && options?.fallbackToLatest) {
    targetId = findLatestConversationId(brainDir) || undefined;
  }

  const fallback: ChatContextUsage = {
    conversationId: targetId || '',
    currentTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };

  if (!targetId) return fallback;

  const transcriptPath = path.join(brainDir, targetId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (!fs.existsSync(transcriptPath)) return fallback;

    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return fallback;

    let fileContent: string;
    if (stat.size <= 2 * 1024 * 1024) {
      fileContent = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const readSize = Math.min(stat.size, 512 * 1024);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }
      fileContent = buffer.toString('utf8');
    }

    const lines = fileContent.split('\n');
    let lastModelInputTokens: number | undefined;
    let lastModelCacheTokens: number | undefined;
    let lastModelOutputTokens: number | undefined;
    let postCompactionChars = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);

        if (
          entry.type === 'CHECKPOINT' ||
          (typeof entry.content === 'string' && entry.content.includes('Resuming from a compaction'))
        ) {
          if (entry.content) postCompactionChars += entry.content.length;
          break;
        }

        if (
          lastModelInputTokens === undefined &&
          entry.source === 'MODEL' &&
          typeof entry.input_tokens === 'number' &&
          entry.input_tokens > 0
        ) {
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
      } catch {
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
  } catch {
  }

  return fallback;
}

export function normalizeModelName(str?: string): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u25be\u25b2\u25bc\u25c2\u25b8\u25c0\u25b6\^]/g, ' ')
    .replace(/\s+[vV]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function cleanModelSlug(s?: string): string {
  if (!s || typeof s !== 'string') return '';
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


export function resolveModelContextLimit(
  modelName?: string,
  customModels?: ModelContextLookupEntry[],
): number | undefined {
  if (!modelName) return undefined;
  const clean = normalizeModelName(modelName);
  if (!clean) return undefined;

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
    } catch {
    }
  }

  if (modelsList && Array.isArray(modelsList)) {
    const slug = cleanModelSlug(clean);
    for (const cm of modelsList) {
      const cmName = normalizeModelName(cm.name || '');
      const cmDisplay = normalizeModelName(cm.displayName || '');
      const cmExt = normalizeModelName(cm.externalModelName || '');
      const cmSlug = cleanModelSlug(cm.displayName || cm.name || '');

      const exact =
        (cmDisplay && clean === cmDisplay) ||
        (cmName && clean === cmName) ||
        (cmExt && clean === cmExt) ||
        (slug && cmSlug && slug === cmSlug);

      const fuzzy =
        (cmDisplay.length >= 4 && (clean.includes(cmDisplay) || cmDisplay.includes(clean))) ||
        (cmExt.length >= 4 && (clean.includes(cmExt) || cmExt.includes(clean))) ||
        (slug.length >= 4 && cmSlug.length >= 4 && (slug.includes(cmSlug) || cmSlug.includes(slug)));

      if (exact || fuzzy) {
        if (typeof cm.contextWindow === 'number' && cm.contextWindow > 0) return cm.contextWindow;
        if (typeof cm.nativeContextWindow === 'number' && cm.nativeContextWindow > 0) return cm.nativeContextWindow;
      }
    }
  }

  if (clean.includes('gemini')) {
    if (clean.includes('pro') || clean.includes('1.5-pro') || clean.includes('2.5-pro')) {
      return 2_000_000;
    }
    if (clean.includes('flash') || clean.includes('1.5-flash') || clean.includes('2.0-flash') || clean.includes('2.5-flash') || clean.includes('3.8-flash')) {
      return 1_000_000;
    }
    if (clean.includes('1.0-pro') || clean.includes('1.0 pro')) {
      return 32_000;
    }
    return 1_000_000;
  }

  if (clean.includes('claude') || clean.includes('sonnet') || clean.includes('opus') || clean.includes('haiku')) {
    return 200_000;
  }

  if (/\bo[13](?:-mini|-preview)?\b/.test(clean)) {
    return 200_000;
  }

  if (clean.includes('gpt-4') || clean.includes('gpt4') || clean.includes('chatgpt')) {
    return 128_000;
  }


  if (clean.includes('deepseek')) {
    return 64_000;
  }

  if (clean.includes('mistral') || clean.includes('codestral') || clean.includes('llama') || clean.includes('qwen')) {
    return 128_000;
  }

  return undefined;
}

let modelsDevApiCache: any = null;
let modelsDevApiCacheTime = 0;

export async function fetchContextLimitFromApi(targetSlug: string): Promise<number | undefined> {
  const cleanTarget = targetSlug.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!cleanTarget) return undefined;

  const now = Date.now();
  if (!modelsDevApiCache || now - modelsDevApiCacheTime > 300_000) {
    try {
      const res = await fetch('https://models.dev/api.json?type=all', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        modelsDevApiCache = await res.json();
        modelsDevApiCacheTime = now;
      }
    } catch {
      return undefined;
    }
  }

  if (!modelsDevApiCache || typeof modelsDevApiCache !== 'object') return undefined;

  let substringMatch: number | undefined;

  for (const provider of Object.values(modelsDevApiCache)) {
    if (!provider || typeof provider !== 'object' || !(provider as any).models) continue;
    const models = (provider as any).models;
    for (const [mId, mObj] of Object.entries(models)) {
      if (!mObj || typeof mObj !== 'object') continue;
      const m = mObj as any;
      const context = m.limit?.context;
      if (typeof context !== 'number' || context <= 0) continue;

      const cleanId = mId.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const cleanName = String(m.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const cleanCanon = String(m.canonical_model_id || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

      if (cleanId === cleanTarget || cleanName === cleanTarget || cleanCanon === cleanTarget) {
        return context;
      }

      if (
        !substringMatch &&
        cleanTarget.length >= 4 &&
        (cleanId.includes(cleanTarget) || cleanName.includes(cleanTarget) || cleanCanon.includes(cleanTarget))
      ) {
        substringMatch = context;
      }
    }
  }

  return substringMatch;
}

export function updateCustomModelContextWindow(
  modelName: string,
  contextWindow: number,
  customDbPath?: string,
): boolean {
  const dbPath = customDbPath || path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
  try {
    if (!fs.existsSync(dbPath)) return false;
    const raw = fs.readFileSync(dbPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.models)) return false;

    const clean = normalizeModelName(modelName);
    const slug = cleanModelSlug(clean);
    let updated = false;

    for (const cm of data.models) {
      const cmName = normalizeModelName(cm.name || '');
      const cmDisplay = normalizeModelName(cm.displayName || '');
      const cmExt = normalizeModelName(cm.externalModelName || '');
      const cmSlug = cleanModelSlug(cm.displayName || cm.name || '');

      const match =
        (cmDisplay && clean === cmDisplay) ||
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
  } catch {
  }
  return false;
}

export function formatTokenCount(tokens: number): string {
  if (typeof tokens !== 'number' || isNaN(tokens) || tokens < 0) return '0';
  return Math.round(tokens).toLocaleString('en-US');
}

export function formatContextUnit(tokens: number): string {
  if (typeof tokens !== 'number' || isNaN(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return (Number.isInteger(m) ? m.toString() : m.toFixed(1).replace(/\.0$/, '')) + 'M';
  }
  const k = tokens / 1_000;
  return (Number.isInteger(k) ? k.toString() : Math.round(k).toString()) + 'k';
}

export function formatContextTooltip(currentTokens: number, maxTokens?: number): string {
  const formattedCurrent = formatTokenCount(currentTokens);
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    const formattedMax = formatContextUnit(maxTokens);
    const pct = Math.round((currentTokens / maxTokens) * 1000) / 10;
    return `Context: ${formattedCurrent} / ${formattedMax} (${pct}%)`;
  }
  return `Context: ${formattedCurrent} / Unknown`;
}
