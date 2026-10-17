import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Types ────────────────────────────────────────────────────────────────

export interface StreamContext {
  accumulatedText: string;
  accumulatedReasoning: string;
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
}

export interface StateTimestamps {
  streamCtx: Map<string, number>;
  toolCallIds: Map<string, number>;
  translatedCalls: Map<string, number>;
  reasoning: Map<string, number>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd: string;
}

// ─── State ────────────────────────────────────────────────────────────────

/** modelName → { "functionName": "original_tool_call_id" } */
export const modelToolCallIds = new Map<string, Record<string, string>>();

/** modelName → preserved reasoning_content from previous turn */
export const modelReasoningContent = new Map<string, string>();

/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
export const activeStreamContexts = new Map<string, StreamContext>();

/** toolCallId → { originalName, translatedName, cmd, cwd } */
export const translatedToolCalls = new Map<string, TranslatedCallInfo>();

/** State entry timestamps for periodic cleanup */
export const stateTimestamps: StateTimestamps = {
  streamCtx: new Map(),
  toolCallIds: new Map(),
  translatedCalls: new Map(),
  reasoning: new Map(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────

export function touchStateTimestamp(map: Map<string, number>, key: string): void {
  map.set(key, Date.now());
}

// ─── Periodic Cleanup (managed lifecycle) ─────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return; // already running
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const STREAM_TTL = 600_000; // 10 minutes for active stream contexts
    const TOOL_TTL = 1_800_000; // 30 minutes for tool call IDs & reasoning

    for (const [key, ts] of stateTimestamps.streamCtx) {
      if (now - ts > STREAM_TTL) {
        activeStreamContexts.delete(key);
        stateTimestamps.streamCtx.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolCallIds) {
      if (now - ts > TOOL_TTL) {
        modelToolCallIds.delete(key);
        stateTimestamps.toolCallIds.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.translatedCalls) {
      if (now - ts > TOOL_TTL) {
        translatedToolCalls.delete(key);
        stateTimestamps.translatedCalls.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.reasoning) {
      if (now - ts > TOOL_TTL) {
        modelReasoningContent.delete(key);
        stateTimestamps.reasoning.delete(key);
      }
    }
  }, 300_000);
  // Importing translator/model-management helpers must not keep a CLI process alive.
  cleanupInterval.unref?.();
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();

let latestOfficialQuota: Record<string, unknown> | undefined;
let latestOfficialQuotaEmail: string | undefined;
let latestOfficialQuotaAt = 0;

function getOfficialQuotaPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || (typeof os !== 'undefined' ? os.homedir() : '');
  return path.join(home, '.gemini', 'antigravity', '.official_quota.json');
}

export function recordOfficialQuota(data: Record<string, unknown>, email?: string): void {
  if (data && typeof data === 'object') {
    latestOfficialQuota = data;
    const extractedEmail =
      email ||
      (typeof data.userEmail === 'string'
        ? data.userEmail
        : typeof (data.user as Record<string, unknown> | undefined)?.email === 'string'
          ? ((data.user as Record<string, unknown>).email as string)
          : undefined);
    if (extractedEmail) latestOfficialQuotaEmail = extractedEmail.trim().toLowerCase();
    latestOfficialQuotaAt = Date.now();
    try {
      const p = getOfficialQuotaPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        JSON.stringify({
          updatedAt: latestOfficialQuotaAt,
          email: latestOfficialQuotaEmail,
          data: latestOfficialQuota,
        }),
        'utf8',
      );
    } catch {}
  }
}

export function getOfficialQuota(filterEmail?: string): Record<string, unknown> | undefined {
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
  } catch {}
  return undefined;
}
