/** Bounded, credential-free interpretation of Google's structured rate-limit responses. */
export type GoogleCooldownReason = 'rate-limited' | 'quota-exhausted' | 'upstream-error';

export interface GoogleRateLimitDecision {
  reason: GoogleCooldownReason;
  retryAfterMs?: number;
}

// Retain real weekly reset hints without permitting unbounded timestamps or timer overflow.
const MAX_DELAY_MS = 31 * 24 * 60 * 60 * 1000;
function boundedDelay(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.min(MAX_DELAY_MS, Math.ceil(value)) : undefined;
}

function duration(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^(?:\d+(?:\.\d+)?[smhd])+$/.test(value)) return undefined;
    let total = 0;
    const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += Number(match[1]) * units[match[2]];
    return boundedDelay(total);
  }
  if (value && typeof value === 'object') {
    const { seconds, nanos = 0 } = value as Record<string, unknown>;
    if (
      !/^(?:0|[1-9]\d*)$/.test(String(seconds)) ||
      !Number.isInteger(nanos) ||
      Number(nanos) < 0 ||
      Number(nanos) >= 1e9
    )
      return undefined;
    return boundedDelay(Number(seconds) * 1000 + Number(nanos) / 1e6);
  }
  return undefined;
}

export function classifyGoogleRateLimit(
  body: string,
  retryAfter?: string | string[],
  now = Date.now(),
): GoogleRateLimitDecision {
  const header = (Array.isArray(retryAfter) ? retryAfter[0] : retryAfter)?.trim();
  let retryAfterMs = header
    ? boundedDelay(/^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now)
    : undefined;
  let reason: GoogleCooldownReason = 'rate-limited';
  try {
    const data = JSON.parse(body.slice(0, 16 * 1024));
    const error = data?.error && typeof data.error === 'object' ? data.error : data;
    const details = Array.isArray(error?.details) ? error.details.slice(0, 32) : [];
    // Only examine structured error descriptions, never entire echoed request payloads.
    const descriptions = typeof error?.message === 'string' ? [error.message.slice(0, 2048)] : [];
    const hints: number[] = [];
    if (typeof error?.message === 'string') {
      const resetMatch = error.message.match(/resets\s*in\s*([0-9smhd]+)/i);
      if (resetMatch) {
        const delay = duration(resetMatch[1]);
        if (delay !== undefined) hints.push(delay);
      }
    }
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
        const delay = duration(detail.retryDelay);
        if (delay !== undefined) hints.push(delay);
      }
      if (detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') {
        if (typeof detail.reason === 'string') descriptions.push(detail.reason.slice(0, 256));
        const metadata = detail.metadata;
        if (!metadata || typeof metadata !== 'object') continue;
        const delay = duration(metadata.quotaResetDelay);
        if (delay !== undefined) hints.push(delay);
        const reset = metadata.quotaResetTimeStamp ?? metadata.quotaResetTimestamp;
        if (typeof reset === 'string') {
          const until = boundedDelay(Date.parse(reset) - now);
          if (until !== undefined) hints.push(until);
        }
      }
    }
    const description = descriptions.join(' ').toLowerCase();
    // RESOURCE_EXHAUSTED alone also describes short rate limits, so does not imply a long quota window.
    if (
      !/per[_ ]minute|\brpm\b|rate[_ ]limit/.test(description) &&
      /quota[_ ]exhausted|daily[_ ]limit|weekly[_ ]limit|insufficient[_ ]credits?|individual\s*quota|quota\s*(?:reached|exceeded)/.test(description)
    )
      reason = 'quota-exhausted';
    if (retryAfterMs === undefined && hints.length) retryAfterMs = Math.max(...hints);
  } catch {
    // Malformed/non-JSON bodies receive the configured fallback delay, never a fabricated reset window.
  }
  return { reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
