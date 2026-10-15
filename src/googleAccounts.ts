/** Google Cloud Code account pools. OAuth applications and credentials are supplied by the user. */
import * as http from 'http';
import * as https from 'https';
import { createHash, randomInt } from 'crypto';
import type { GoogleCooldownReason } from './googlePoolPolicy';
import { describeGoogleAccessError, type GoogleAccessErrorCategory } from './googleAccessErrors';
import { fetchGoogleUserInfo } from './googleOAuth';

/** A consistent identifier for this application across Cloud Code account and generation requests. */
export const GOOGLE_CLOUD_CODE_USER_AGENT = 'antigravity-add-model';

export interface GoogleAccount {
  id: string;
  label?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  authMode?: 'custom' | 'antigravity';
  /** Origin returned by explicit account preparation; never a provider-supplied arbitrary URL. */
  cloudCodeEndpoint?: string;
  project?: string;
  enabled?: boolean;
}
export interface GooglePoolOptions {
  strategy?: 'round-robin' | 'least-loaded' | 'quota' | 'adaptive';
  maxConcurrency?: number;
  cooldownMs?: number;
}
export interface GoogleQuotaBucket {
  id: string;
  displayName?: string;
  groupName?: string;
  remainingFraction?: number;
  resetTime?: string;
}
export interface GoogleQuotaGroup {
  name: string;
  displayName?: string;
  buckets: GoogleQuotaBucket[];
}
export interface GoogleQuotaSnapshot {
  accountId: string;
  checkedAt: number;
  remainingFraction?: number;
  planTier?: string;
  email?: string;
  name?: string;
  buckets: GoogleQuotaBucket[];
  groups?: GoogleQuotaGroup[];
}
interface PoolState {
  id: string;
  label?: string;
  inFlight: number;
  lastUsed: number;
  cooldownUntil: number;
  modelCooldowns: Map<string, { until: number; reason: GoogleCooldownReason }>;
  requests: number;
  succeeded: number;
  failed: number;
  consecutiveFailures: number;
  lastStatus?: number;
  latency?: { average: number; measuredAt: number };
  authState?: 'unauthorized' | 'forbidden';
  quota?: GoogleQuotaSnapshot;
}
export interface GoogleAccountLease {
  account: GoogleAccount;
  release(result?: {
    status?: number;
    retryAfterMs?: number;
    cooldownReason?: GoogleCooldownReason;
    latencyMs?: number;
    cancelled?: boolean;
  }): void;
}
export class GoogleAccountError extends Error {
  readonly category: GoogleAccessErrorCategory;
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.category = describeGoogleAccessError(status).category;
  }
}

const tokenCache = new Map<string, GoogleAccount>();
const refreshing = new Map<string, Promise<GoogleAccount>>();
const poolStates = new Map<string, PoolState>();
const sticky = new Map<string, { accountKey: string; accountId?: string; at: number }>();
let selectionOrder = 0;
const MEASUREMENT_TTL_MS = 10 * 60_000;
let persistAccount:
  | ((modelName: string, account: GoogleAccount, previousAccount: GoogleAccount) => Promise<void> | void)
  | undefined;

export function configureGoogleAccountPersistence(callback?: typeof persistAccount): void {
  persistAccount = callback;
}
function accountKey(account: GoogleAccount): string {
  return createHash('sha256')
    .update(JSON.stringify([account.id, account.clientId, account.refreshToken || account.accessToken]))
    .digest('hex');
}
function poolKey(account: GoogleAccount): string {
  // Account IDs survive refreshed/rotated credentials, so parallel models share one capacity limit.
  return createHash('sha256')
    .update(JSON.stringify([account.id, account.clientId]))
    .digest('hex');
}
function stateFor(account: GoogleAccount): PoolState {
  const key = poolKey(account);
  let state = poolStates.get(key);
  if (!state) {
    state = {
      id: account.id,
      label: account.label,
      inFlight: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      modelCooldowns: new Map(),
      requests: 0,
      succeeded: 0,
      failed: 0,
      consecutiveFailures: 0,
    };
    poolStates.set(key, state);
  }
  state.label = account.label;
  for (const [model, cooldown] of state.modelCooldowns) {
    if (cooldown.until <= Date.now()) state.modelCooldowns.delete(model);
  }
  return state;
}

function quotaIsFresh(quota?: GoogleQuotaSnapshot, now = Date.now()): boolean {
  return (
    !!quota &&
    now >= quota.checkedAt &&
    now - quota.checkedAt < MEASUREMENT_TTL_MS &&
    !quota.buckets.some((bucket) => bucket.resetTime && Date.parse(bucket.resetTime) <= now)
  );
}
function quotaExhausted(state: PoolState, now = Date.now(), modelName?: string): boolean {
  if (!quotaIsFresh(state.quota, now)) return false;
  const buckets = state.quota?.buckets || [];
  if (!buckets.length) return false;

  if (modelName) {
    const isThirdParty = /claude|gpt|anthropic|openai/i.test(modelName);
    const matching = buckets.filter((b) => {
      const g = b.groupName || b.id || '';
      return isThirdParty
        ? /claude|gpt|anthropic|openai|third[- ]?party/i.test(g)
        : !/claude|gpt|anthropic|openai|third[- ]?party/i.test(g);
    });
    if (matching.length > 0) {
      return matching.every((b) => b.remainingFraction === 0);
    }
    if (isThirdParty && state.quota?.groups && state.quota.groups.length > 0) {
      const hasThirdParty = state.quota.groups.some((g) =>
        /claude|gpt|anthropic|openai|third[- ]?party/i.test(g.name || g.displayName || ''),
      );
      if (!hasThirdParty) return true;
    }
  }

  // Depleted Claude bucket must not disable an account with remaining Gemini quota
  return buckets.every((bucket) => bucket.remainingFraction === 0);
}
function measuredLatency(state: PoolState, now = Date.now()): number | undefined {
  return state.latency && now - state.latency.measuredAt < MEASUREMENT_TTL_MS ? state.latency.average : undefined;
}
function adaptiveScore(state: PoolState, modelName?: string): number {
  let quota = quotaIsFresh(state.quota) ? state.quota?.remainingFraction : undefined;
  if (modelName && quotaIsFresh(state.quota) && state.quota?.buckets?.length) {
    const isThirdParty = /claude|gpt|anthropic|openai/i.test(modelName);
    const matching = state.quota.buckets.filter((b) => {
      const g = b.groupName || b.id || '';
      return isThirdParty
        ? /claude|gpt|anthropic|openai|third[- ]?party/i.test(g)
        : !/claude|gpt|anthropic|openai|third[- ]?party/i.test(g);
    });
    if (matching.length > 0) {
      const nums = matching.flatMap((b) => (b.remainingFraction !== undefined ? [b.remainingFraction] : []));
      if (nums.length > 0) quota = Math.min(...nums);
    }
  }
  return (
    (quota ?? 0.5) * 100 -
    state.inFlight * 20 -
    Math.min(40, (measuredLatency(state) ?? 0) / 100) -
    Math.min(30, state.consecutiveFailures * 10)
  );
}
function selectAdaptive(candidates: GoogleAccount[], modelName?: string): GoogleAccount | undefined {
  if (candidates.length < 2) return candidates[0];
  const first = randomInt(candidates.length);
  let second = randomInt(candidates.length - 1);
  if (second >= first) second++;
  const a = stateFor(candidates[first]),
    b = stateFor(candidates[second]);
  const difference = adaptiveScore(a, modelName) - adaptiveScore(b, modelName);
  return difference > 0 || (difference === 0 && a.lastUsed <= b.lastUsed) ? candidates[first] : candidates[second];
}
function validAccess(account: GoogleAccount): boolean {
  return (
    !!account.accessToken &&
    !/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.accessToken) &&
    (!account.expiresAt || account.expiresAt > Date.now() + 60_000)
  );
}
function checkedEndpoint(value: string, hosts: string[]): URL {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (!local && (url.protocol !== 'https:' || !hosts.includes(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new GoogleAccountError('Google credentials may only be sent to the configured official service.', 400);
  }
  return url;
}

/** Preserve local test/custom endpoints, and use the prepared tier for official Google requests. */
export function googleAccountEndpoint(account: GoogleAccount, configured?: string): string {
  const official = ['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com'];
  if (account.cloudCodeEndpoint !== undefined && !official.includes(account.cloudCodeEndpoint))
    throw new GoogleAccountError('Prepared Google endpoint must be an official Cloud Code origin.', 400);
  const selected = checkedEndpoint(
    configured || account.cloudCodeEndpoint || official[1],
    official.map((url) => new URL(url).hostname),
  );
  return account.cloudCodeEndpoint && official.includes(selected.origin)
    ? account.cloudCodeEndpoint
    : selected.toString();
}

async function postJson(
  url: URL,
  headers: http.OutgoingHttpHeaders,
  body: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024)
            request.destroy(new GoogleAccountError('Google account response is too large.', 502));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new GoogleAccountError('Google account response was interrupted.', 502)));
        response.on('end', () => {
          const status = response.statusCode || 502;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
            resolve({ status, data });
          } catch {
            // Preserve an upstream denial/overload even when its error page is HTML or empty.
            if (status < 200 || status >= 300) resolve({ status, data: {} });
            else reject(new GoogleAccountError('Google account service returned invalid JSON.', 502));
          }
        });
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new GoogleAccountError('Google account request timed out.', 504)),
      10_000,
    );
    request.once('close', () => clearTimeout(timeout));
    request.once('error', (error) =>
      reject(
        error instanceof GoogleAccountError
          ? error
          : new GoogleAccountError('Google account service could not be reached.', 502),
      ),
    );
    request.end(body);
  });
}

/** Refresh requests are coalesced and cached. Endpoint override is restricted to localhost fixtures. */
export async function refreshGoogleAccount(
  account: GoogleAccount,
  tokenEndpointOverride = 'https://oauth2.googleapis.com/token',
): Promise<GoogleAccount> {
  for (const [key, cached] of tokenCache) if (cached.expiresAt && cached.expiresAt < Date.now()) tokenCache.delete(key);
  const key = accountKey(account);
  const cached = tokenCache.get(key);
  if (cached && validAccess(cached))
    return {
      ...account,
      accessToken: cached.accessToken,
      refreshToken: cached.refreshToken,
      expiresAt: cached.expiresAt,
    };
  if (validAccess(account)) return { ...account };
  if (
    !account.refreshToken ||
    !account.clientId ||
    /^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.refreshToken)
  ) {
    throw new GoogleAccountError(
      'This account requires a valid access token or a refresh token and your OAuth client ID.',
      401,
    );
  }
  const active = refreshing.get(key);
  if (active) {
    const updated = await active;
    // Sharing a token refresh must not replace this model's prepared project or service route.
    return {
      ...account,
      accessToken: updated.accessToken,
      refreshToken: updated.refreshToken,
      expiresAt: updated.expiresAt,
    };
  }
  const refresh = (async () => {
    const endpoint = checkedEndpoint(tokenEndpointOverride, ['oauth2.googleapis.com']);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken!,
      client_id: account.clientId!,
    });
    if (account.clientSecret) body.set('client_secret', account.clientSecret);
    const { status, data } = await postJson(
      endpoint,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      body.toString(),
    );
    if (status < 200 || status >= 300 || typeof data.access_token !== 'string' || !data.access_token) {
      const invalidGrant = data.error === 'invalid_grant' || data.error === 'invalid_client';
      throw new GoogleAccountError(
        invalidGrant
          ? 'Google rejected these OAuth credentials; reconnect this account.'
          : describeGoogleAccessError(status >= 400 ? status : 502, 'oauth').message,
        invalidGrant ? 401 : status >= 400 ? status : 502,
      );
    }
    const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    const updated = { ...account, accessToken: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    if (typeof data.refresh_token === 'string' && data.refresh_token) updated.refreshToken = data.refresh_token;
    tokenCache.set(key, updated);
    tokenCache.set(accountKey(updated), updated);
    return updated;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, refresh);
  return refresh;
}

/** Explicit quota refresh; never infers subscription eligibility or fabricates an available quota. */
export async function fetchGoogleQuota(account: GoogleAccount, baseURL?: string): Promise<GoogleQuotaSnapshot> {
  const endpoint = new URL(googleAccountEndpoint(account, baseURL));
  endpoint.pathname = '/v1internal:retrieveUserQuotaSummary';
  endpoint.search = '';
  const current = await refreshGoogleAccount(account);
  const { status, data } = await postJson(
    endpoint,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${current.accessToken}`,
      'User-Agent': GOOGLE_CLOUD_CODE_USER_AGENT,
    },
    JSON.stringify(account.project ? { project: account.project } : {}),
  );
  if (status < 200 || status >= 300)
    throw new GoogleAccountError(describeGoogleAccessError(status, 'quota').message, status);
  const buckets: GoogleQuotaBucket[] = [];
  const groups: GoogleQuotaGroup[] = [];
  const rawGroups = Array.isArray(data.groups)
    ? data.groups
    : Array.isArray(data.buckets)
      ? [{ buckets: data.buckets }]
      : [];
  for (const group of rawGroups) {
    if (!group || typeof group !== 'object') continue;
    const groupName =
      typeof group.displayName === 'string' && group.displayName.trim()
        ? group.displayName.trim()
        : typeof group.name === 'string' && group.name.trim()
          ? group.name.trim()
          : typeof group.title === 'string' && group.title.trim()
            ? group.title.trim()
            : typeof group.label === 'string' && group.label.trim()
              ? group.label.trim()
              : typeof group.id === 'string' && group.id.trim()
                ? group.id.trim()
                : undefined;

    const groupBuckets: GoogleQuotaBucket[] = [];
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (!bucket || typeof bucket !== 'object') continue;
      const bId =
        typeof bucket.bucketId === 'string'
          ? bucket.bucketId
          : typeof bucket.id === 'string'
            ? bucket.id
            : 'quota';
      const bDisplayName =
        typeof bucket.displayName === 'string'
          ? bucket.displayName
          : typeof bucket.title === 'string'
            ? bucket.title
            : typeof bucket.label === 'string'
              ? bucket.label
              : undefined;
      const bFraction =
        typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
          ? Math.max(0, Math.min(1, bucket.remainingFraction))
          : undefined;
      const bReset = typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined;

      const item: GoogleQuotaBucket = {
        id: bId,
        ...(bDisplayName ? { displayName: bDisplayName } : {}),
        ...(groupName ? { groupName } : {}),
        remainingFraction: bFraction,
        resetTime: bReset,
      };
      groupBuckets.push(item);
      buckets.push(item);
    }
    if (groupBuckets.length > 0 || groupName) {
      groups.push({
        name: groupName || 'Models',
        displayName: groupName || 'Models',
        buckets: groupBuckets,
      });
    }
  }
  const remaining = buckets.flatMap((bucket) =>
    bucket.remainingFraction === undefined ? [] : [bucket.remainingFraction],
  );
  const rawTier =
    typeof data?.subscriptionTier === 'string'
      ? data.subscriptionTier
      : typeof data?.userTier === 'string'
        ? data.userTier
        : typeof data?.planTier === 'string'
          ? data.planTier
          : typeof (data?.paidTier as any)?.tier === 'string'
            ? (data?.paidTier as any).tier
            : undefined;
  let planTier: string | undefined;
  if (rawTier) {
    const lower = rawTier.toLowerCase();
    if (lower.includes('enterprise')) planTier = 'Enterprise';
    else if (lower.includes('trial')) planTier = 'Pro Trial';
    else if (lower.includes('pro')) planTier = 'Pro';
    else if (lower.includes('free')) planTier = 'Free';
    else planTier = rawTier.charAt(0).toUpperCase() + rawTier.slice(1);
  }
  const rawData = data as Record<string, any> | undefined;
  let email =
    account.email ||
    (typeof rawData?.userEmail === 'string'
      ? rawData.userEmail
      : typeof rawData?.email === 'string'
        ? rawData.email
        : typeof rawData?.user?.email === 'string'
          ? rawData.user.email
          : undefined);
  let name: string | undefined;
  if (!email && current.accessToken) {
    try {
      const info = await fetchGoogleUserInfo(current.accessToken);
      if (info.email) email = info.email;
      if (info.name) name = info.name;
    } catch {}
  }
  if (email && !account.email) {
    account.email = email;
  }
  if (email && (!account.label || account.label.toLowerCase() === 'google account')) {
    account.label = email;
    stateFor(account).label = email;
  }
  const snapshot: GoogleQuotaSnapshot = {
    accountId: account.id,
    checkedAt: Date.now(),
    planTier,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    buckets,
    ...(groups.length > 0 ? { groups } : {}),
    remainingFraction: remaining.length ? Math.min(...remaining) : undefined,
  };
  stateFor(account).quota = snapshot;
  return snapshot;
}

/** Discover only the models returned for this authenticated account/project. */
export async function fetchGoogleModels(
  account: GoogleAccount,
  baseURL?: string,
): Promise<{ id: string; displayName: string }[]> {
  const endpoint = new URL(googleAccountEndpoint(account, baseURL));
  endpoint.pathname = '/v1internal:fetchAvailableModels';
  endpoint.search = '';
  const current = await refreshGoogleAccount(account);
  const { status, data } = await postJson(
    endpoint,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${current.accessToken}`,
      'User-Agent': GOOGLE_CLOUD_CODE_USER_AGENT,
    },
    JSON.stringify(current.project ? { project: current.project } : {}),
  );
  if (status < 200 || status >= 300)
    throw new GoogleAccountError(describeGoogleAccessError(status, 'models').message, status);
  const models = data.models || data.availableModels || data.available_models;
  if (!models || typeof models !== 'object')
    throw new GoogleAccountError('Google did not return an available model list.', 502);
  const entries = Array.isArray(models) ? models.map((value) => ['', value] as const) : Object.entries(models);
  const found = new Map<string, { id: string; displayName: string }>();
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const model = value as Record<string, unknown>;
    const candidate = model.id || model.name || key || model.modelId || model.model;
    if (typeof candidate !== 'string' || !candidate) continue;
    const id = candidate.replace(/^models\//, '');
    const displayName = typeof model.displayName === 'string' ? model.displayName : id;
    found.set(id, { id, displayName });
  }
  return [...found.values()];
}

export async function acquireGoogleAccount(
  modelName: string,
  accounts: GoogleAccount[],
  options: GooglePoolOptions = {},
  requestIdentity?: string,
  cooldownScope = modelName,
): Promise<GoogleAccountLease> {
  const attempted = new Set<string>();
  const identityKey = requestIdentity
    ? createHash('sha256').update(`${modelName}\0${requestIdentity}`).digest('hex')
    : undefined;
  for (const [key, entry] of sticky) if (Date.now() - entry.at > 3_600_000) sticky.delete(key);
  if (sticky.size > 2000) sticky.delete(sticky.keys().next().value!);
  while (attempted.size < accounts.length) {
    const now = Date.now();
    let candidates = accounts.filter((account) => {
      const state = stateFor(account);
      return (
        account.enabled !== false &&
        !attempted.has(poolKey(account)) &&
        !state.authState &&
        state.cooldownUntil <= now &&
        (state.modelCooldowns.get(cooldownScope)?.until ?? 0) <= now &&
        !quotaExhausted(state, now, modelName) &&
        state.inFlight < (options.maxConcurrency ?? 2)
      );
    });
    candidates = candidates.sort((left, right) => {
      const a = stateFor(left),
        b = stateFor(right);
      if (options.strategy === 'least-loaded' && a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
      if (options.strategy === 'quota') {
        const getFraction = (state: PoolState) => {
          if (!quotaIsFresh(state.quota, now) || !state.quota?.buckets?.length) return 0.5;
          if (modelName) {
            const isThirdParty = /claude|gpt|anthropic|openai/i.test(modelName);
            const matching = state.quota.buckets.filter((bucket) => {
              const g = bucket.groupName || bucket.id || '';
              return isThirdParty
                ? /claude|gpt|anthropic|openai|third[- ]?party/i.test(g)
                : !/claude|gpt|anthropic|openai|third[- ]?party/i.test(g);
            });
            if (matching.length > 0) {
              const nums = matching.flatMap((bucket) => (bucket.remainingFraction !== undefined ? [bucket.remainingFraction] : []));
              if (nums.length > 0) return Math.min(...nums);
            }
          }
          return state.quota.remainingFraction ?? 0.5;
        };
        const qa = getFraction(a),
          qb = getFraction(b);
        if (qa !== qb) return qb - qa;
      }
      return a.lastUsed - b.lastUsed;
    });
    const stick = identityKey ? sticky.get(identityKey) : undefined;
    const stickyCandidate = stick ? candidates.find((account) => poolKey(account) === stick.accountKey) : undefined;
    const eligibleSticky =
      stickyCandidate && stateFor(stickyCandidate).consecutiveFailures === 0 && !stateFor(stickyCandidate).authState
        ? stickyCandidate
        : undefined;
    const selected =
      eligibleSticky ||
      (options.strategy === 'adaptive' ? selectAdaptive(candidates, modelName) : candidates[0]);
    if (!selected)
      throw new GoogleAccountError(
        'No Google account is currently eligible: check authentication, quota, cooldown and concurrency limits.',
        503,
      );
    const key = poolKey(selected),
      state = stateFor(selected);
    attempted.add(key);
    state.inFlight += 1;
    state.lastUsed = ++selectionOrder;
    try {
      const updated = await refreshGoogleAccount(selected);
      if (
        updated.accessToken !== selected.accessToken ||
        updated.refreshToken !== selected.refreshToken ||
        updated.expiresAt !== selected.expiresAt
      ) {
        await persistAccount?.(modelName, updated, selected);
      }
      if (identityKey) sticky.set(identityKey, { accountKey: key, accountId: selected.id, at: Date.now() });
      state.requests++;
      let released = false;
      return {
        account: updated,
        release(result = {}) {
          if (released) return;
          released = true;
          state.inFlight = Math.max(0, state.inFlight - 1);
          if (result.cancelled) return;
          if (result.status !== undefined) state.lastStatus = result.status;
          if (result.status >= 200 && result.status < 400) {
            state.succeeded++;
            state.consecutiveFailures = 0;
            if (Number.isFinite(result.latencyMs) && result.latencyMs >= 0) {
              const previous = measuredLatency(state);
              state.latency = {
                average: Math.round(
                  previous === undefined ? result.latencyMs : previous * 0.8 + result.latencyMs * 0.2,
                ),
                measuredAt: Date.now(),
              };
            }
          } else if (result.status >= 400) {
            state.failed++;
            state.consecutiveFailures++;
          }
          if (result.status === 401 || result.status === 403) {
            state.authState = result.status === 401 ? 'unauthorized' : 'forbidden';
            tokenCache.delete(accountKey(selected));
            tokenCache.delete(accountKey(updated));
            for (const [sKey, entry] of sticky) {
              if (entry.accountId === selected.id || entry.accountKey === key) sticky.delete(sKey);
            }
          } else if (result.status === 408 || result.status === 429 || (result.status && result.status >= 500)) {
            for (const [sKey, entry] of sticky) {
              if (entry.accountId === selected.id || entry.accountKey === key) sticky.delete(sKey);
            }
            const delay =
              Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0
                ? result.retryAfterMs
                : (options.cooldownMs ?? 60_000);
            const until = Date.now() + Math.min(delay, 31 * 24 * 60 * 60 * 1000);
            // Concurrent in-flight failures must not shorten a stronger server reset hint.
            if (until >= (state.modelCooldowns.get(cooldownScope)?.until ?? 0)) {
              state.modelCooldowns.set(cooldownScope, {
                until,
                reason: result.cooldownReason || (result.status === 429 ? 'rate-limited' : 'upstream-error'),
              });
            }
          }
        },
      };
    } catch (error) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (error instanceof GoogleAccountError && [401, 403].includes(error.status))
        state.authState = error.status === 401 ? 'unauthorized' : 'forbidden';
      else state.cooldownUntil = Date.now() + (options.cooldownMs ?? 60_000);
    }
  }
  throw new GoogleAccountError(
    'No Google account could authenticate; reconnect an account or check its OAuth client configuration.',
    401,
  );
}

export function recordGoogleAccountFailure(
  account: GoogleAccount,
  status: number,
  retryAfterMs?: number,
  cooldownScope?: string,
  reason?: GoogleCooldownReason,
): void {
  const state = stateFor(account);
  state.failed++;
  state.consecutiveFailures++;
  state.lastStatus = status;
  for (const [sKey, entry] of sticky) {
    if (entry.accountId === account.id || entry.accountKey === poolKey(account)) sticky.delete(sKey);
  }
  if (status === 401 || status === 403) {
    state.authState = status === 401 ? 'unauthorized' : 'forbidden';
    tokenCache.delete(accountKey(account));
  } else if (status === 408 || status === 429 || (status && status >= 500)) {
    const delay = Number.isFinite(retryAfterMs) && (retryAfterMs as number) >= 0 ? (retryAfterMs as number) : 60_000;
    const until = Date.now() + Math.min(delay, 31 * 24 * 60 * 60 * 1000);
    const scope = cooldownScope || 'global';
    if (until >= (state.modelCooldowns.get(scope)?.until ?? 0)) {
      state.modelCooldowns.set(scope, {
        until,
        reason: reason || (status === 429 ? 'rate-limited' : 'upstream-error'),
      });
    }
  }
}

export function getGooglePoolStatus() {
  const now = Date.now();
  return [...poolStates.values()].map((state) => {
    const modelCooldowns = [...state.modelCooldowns]
      .filter(([, value]) => value.until > now)
      .map(([modelName, value]) => ({ modelName, cooldownUntil: value.until, reason: value.reason }));
    const cooldownUntil = Math.max(state.cooldownUntil, ...modelCooldowns.map((value) => value.cooldownUntil));
    return {
      id: state.id,
      label: state.label,
      inFlight: state.inFlight,
      status:
        state.authState ||
        (quotaExhausted(state, now) ? 'quota-exhausted' : cooldownUntil > now ? 'cooldown' : 'ready'),
      cooldownUntil,
      modelCooldowns,
      requests: state.requests,
      succeeded: state.succeeded,
      failed: state.failed,
      avgLatencyMs: measuredLatency(state, now),
      lastStatus: state.lastStatus,
      lastError: state.lastStatus >= 400 ? describeGoogleAccessError(state.lastStatus) : undefined,
      quotaAgeMs: state.quota ? Math.max(0, now - state.quota.checkedAt) : undefined,
      quotaFresh: quotaIsFresh(state.quota, now),
      quotaExhausted: quotaExhausted(state, now),
      quota: state.quota,
    };
  });
}

/** Clear volatile account state after explicit account edits or sign-in. */
export function resetGoogleAccountState(id?: string): void {
  for (const [key, state] of poolStates) if (!id || state.id === id) poolStates.delete(key);
  for (const [key, account] of tokenCache) if (!id || account.id === id) tokenCache.delete(key);
  if (!id) {
    tokenCache.clear();
    sticky.clear();
  } else {
    for (const [key, entry] of sticky) {
      if (entry.accountId === id || entry.accountKey === id) sticky.delete(key);
    }
  }
}
