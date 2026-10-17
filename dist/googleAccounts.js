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
exports.getOfficialQuota = exports.recordOfficialQuota = exports.GoogleAccountError = exports.GOOGLE_CLOUD_CODE_USER_AGENT = void 0;
exports.configureGoogleAccountPersistence = configureGoogleAccountPersistence;
exports.quotaFamily = quotaFamily;
exports.googleAccountEndpoint = googleAccountEndpoint;
exports.refreshGoogleAccount = refreshGoogleAccount;
exports.fetchGoogleQuota = fetchGoogleQuota;
exports.fetchGoogleModels = fetchGoogleModels;
exports.acquireGoogleAccount = acquireGoogleAccount;
exports.recordGoogleAccountFailure = recordGoogleAccountFailure;
exports.getGooglePoolStatus = getGooglePoolStatus;
exports.resetGoogleAccountState = resetGoogleAccountState;
/** Google Cloud Code account pools. OAuth applications and credentials are supplied by the user. */
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto_1 = require("crypto");
const googleAccessErrors_1 = require("./googleAccessErrors");
const googleOAuth_1 = require("./googleOAuth");
/** A consistent identifier for this application across Cloud Code account and generation requests. */
exports.GOOGLE_CLOUD_CODE_USER_AGENT = 'antigravity-add-model';
class GoogleAccountError extends Error {
    constructor(message, status = 503) {
        super(message);
        this.status = status;
        this.category = (0, googleAccessErrors_1.describeGoogleAccessError)(status).category;
    }
}
exports.GoogleAccountError = GoogleAccountError;
const tokenCache = new Map();
const refreshing = new Map();
const poolStates = new Map();
const sticky = new Map();
let selectionOrder = 0;
const MEASUREMENT_TTL_MS = 10 * 60000;
let persistAccount;
function configureGoogleAccountPersistence(callback) {
    persistAccount = callback;
}
function accountKey(account) {
    return (0, crypto_1.createHash)('sha256')
        .update(JSON.stringify([account.id, account.clientId, account.refreshToken || account.accessToken]))
        .digest('hex');
}
function poolKey(account) {
    // Account IDs survive refreshed/rotated credentials, so parallel models share one capacity limit.
    return (0, crypto_1.createHash)('sha256')
        .update(JSON.stringify([account.id, account.clientId]))
        .digest('hex');
}
function stateFor(account) {
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
        if (cooldown.until <= Date.now())
            state.modelCooldowns.delete(model);
    }
    return state;
}
function quotaIsFresh(quota, now = Date.now()) {
    return (!!quota &&
        now >= quota.checkedAt &&
        now - quota.checkedAt < MEASUREMENT_TTL_MS &&
        !quota.buckets.some((bucket) => bucket.resetTime && Date.parse(bucket.resetTime) <= now));
}
var shared_1 = require("./proxy/shared");
Object.defineProperty(exports, "recordOfficialQuota", { enumerable: true, get: function () { return shared_1.recordOfficialQuota; } });
Object.defineProperty(exports, "getOfficialQuota", { enumerable: true, get: function () { return shared_1.getOfficialQuota; } });
const shared_2 = require("./proxy/shared");
function quotaFamily(name) {
    if (/claude|gpt|anthropic|openai|third[- ]?party/i.test(name))
        return 'third-party';
    if (/gemini|google|flash|pro/i.test(name))
        return 'gemini';
    return undefined;
}
function quotaBuckets(quota, upstreamModel) {
    const wanted = upstreamModel ? quotaFamily(upstreamModel) : undefined;
    if (!wanted)
        return quota.buckets;
    const classified = quota.buckets.map((bucket) => ({
        bucket,
        family: quotaFamily(`${bucket.groupName || ''} ${bucket.id} ${bucket.displayName || ''}`),
    }));
    // Missing family information is unknown eligibility, not proof that the account lacks access.
    return classified.some((entry) => entry.family)
        ? classified.filter((entry) => entry.family === wanted).map((entry) => entry.bucket)
        : quota.buckets;
}
function quotaFraction(state, upstreamModel, now = Date.now()) {
    if (!quotaIsFresh(state.quota, now) || !state.quota)
        return undefined;
    const values = quotaBuckets(state.quota, upstreamModel).flatMap((bucket) => bucket.remainingFraction === undefined ? [] : [bucket.remainingFraction]);
    return values.length ? Math.min(...values) : undefined;
}
function quotaExhausted(state, now = Date.now(), upstreamModel) {
    if (!quotaIsFresh(state.quota, now) || !state.quota)
        return false;
    const buckets = quotaBuckets(state.quota, upstreamModel);
    return buckets.length > 0 && buckets.every((bucket) => bucket.remainingFraction === 0);
}
function measuredLatency(state, now = Date.now()) {
    return state.latency && now - state.latency.measuredAt < MEASUREMENT_TTL_MS ? state.latency.average : undefined;
}
function adaptiveScore(state, modelName) {
    const quota = quotaFraction(state, modelName);
    return ((quota ?? 0.5) * 100 -
        state.inFlight * 20 -
        Math.min(40, (measuredLatency(state) ?? 0) / 100) -
        Math.min(30, state.consecutiveFailures * 10));
}
function selectAdaptive(candidates, modelName) {
    if (candidates.length < 2)
        return candidates[0];
    const first = (0, crypto_1.randomInt)(candidates.length);
    let second = (0, crypto_1.randomInt)(candidates.length - 1);
    if (second >= first)
        second++;
    const a = stateFor(candidates[first]), b = stateFor(candidates[second]);
    const difference = adaptiveScore(a, modelName) - adaptiveScore(b, modelName);
    return difference > 0 || (difference === 0 && a.lastUsed <= b.lastUsed) ? candidates[first] : candidates[second];
}
function validAccess(account) {
    return (!!account.accessToken &&
        !/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.accessToken) &&
        (!account.expiresAt || account.expiresAt > Date.now() + 60000));
}
function checkedEndpoint(value, hosts) {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) ||
        (!local && (url.protocol !== 'https:' || !hosts.includes(url.hostname))) ||
        url.username ||
        url.password) {
        throw new GoogleAccountError('Google credentials may only be sent to the configured official service.', 400);
    }
    return url;
}
/** Preserve local test/custom endpoints, and use the prepared tier for official Google requests. */
function googleAccountEndpoint(account, configured) {
    const official = ['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com'];
    if (account.cloudCodeEndpoint !== undefined && !official.includes(account.cloudCodeEndpoint))
        throw new GoogleAccountError('Prepared Google endpoint must be an official Cloud Code origin.', 400);
    const selected = checkedEndpoint(configured || account.cloudCodeEndpoint || official[1], official.map((url) => new URL(url).hostname));
    return account.cloudCodeEndpoint && official.includes(selected.origin)
        ? account.cloudCodeEndpoint
        : selected.toString();
}
async function postJson(url, headers, body) {
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (response) => {
            let bytes = 0;
            const chunks = [];
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > 2 * 1024 * 1024)
                    request.destroy(new GoogleAccountError('Google account response is too large.', 502));
                else
                    chunks.push(chunk);
            });
            response.on('error', () => reject(new GoogleAccountError('Google account response was interrupted.', 502)));
            response.on('end', () => {
                const status = response.statusCode || 502;
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!data || typeof data !== 'object' || Array.isArray(data))
                        throw new Error();
                    resolve({ status, data });
                }
                catch {
                    // Preserve an upstream denial/overload even when its error page is HTML or empty.
                    if (status < 200 || status >= 300)
                        resolve({ status, data: {} });
                    else
                        reject(new GoogleAccountError('Google account service returned invalid JSON.', 502));
                }
            });
        });
        const timeout = setTimeout(() => request.destroy(new GoogleAccountError('Google account request timed out.', 504)), 10000);
        request.once('close', () => clearTimeout(timeout));
        request.once('error', (error) => reject(error instanceof GoogleAccountError
            ? error
            : new GoogleAccountError('Google account service could not be reached.', 502)));
        request.end(body);
    });
}
/** Refresh requests are coalesced and cached. Endpoint override is restricted to localhost fixtures. */
async function refreshGoogleAccount(account, tokenEndpointOverride = 'https://oauth2.googleapis.com/token') {
    for (const [key, cached] of tokenCache)
        if (cached.expiresAt && cached.expiresAt < Date.now())
            tokenCache.delete(key);
    const key = accountKey(account);
    const cached = tokenCache.get(key);
    if (cached && validAccess(cached))
        return {
            ...account,
            accessToken: cached.accessToken,
            refreshToken: cached.refreshToken,
            expiresAt: cached.expiresAt,
        };
    if (validAccess(account))
        return { ...account };
    if (!account.refreshToken ||
        !account.clientId ||
        /^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.refreshToken)) {
        throw new GoogleAccountError('This account requires a valid access token or a refresh token and your OAuth client ID.', 401);
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
            refresh_token: account.refreshToken,
            client_id: account.clientId,
        });
        if (account.clientSecret)
            body.set('client_secret', account.clientSecret);
        const { status, data } = await postJson(endpoint, { 'Content-Type': 'application/x-www-form-urlencoded' }, body.toString());
        if (status < 200 || status >= 300 || typeof data.access_token !== 'string' || !data.access_token) {
            const invalidGrant = data.error === 'invalid_grant' || data.error === 'invalid_client';
            throw new GoogleAccountError(invalidGrant
                ? 'Google rejected these OAuth credentials; reconnect this account.'
                : (0, googleAccessErrors_1.describeGoogleAccessError)(status >= 400 ? status : 502, 'oauth').message, invalidGrant ? 401 : status >= 400 ? status : 502);
        }
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
        const updated = { ...account, accessToken: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
        if (typeof data.refresh_token === 'string' && data.refresh_token)
            updated.refreshToken = data.refresh_token;
        tokenCache.set(key, updated);
        tokenCache.set(accountKey(updated), updated);
        return updated;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, refresh);
    return refresh;
}
/** Explicit quota refresh; never infers subscription eligibility or fabricates an available quota. */
async function fetchGoogleQuota(account, baseURL, options = {}) {
    const endpoint = new URL(googleAccountEndpoint(account, baseURL));
    endpoint.pathname = '/v1internal:retrieveUserQuotaSummary';
    endpoint.search = '';
    const current = await refreshGoogleAccount(account);
    const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${current.accessToken}`,
        'User-Agent': exports.GOOGLE_CLOUD_CODE_USER_AGENT,
    };
    // 1. Initial query: project-scoped (defaulting to aicode-consumers for official Google services)
    const effectiveProject = account.project || (endpoint.hostname.endsWith('.googleapis.com') ? 'aicode-consumers' : undefined);
    const initialBody = effectiveProject ? JSON.stringify({ project: effectiveProject }) : '{}';
    let { status, data } = await postJson(endpoint, authHeaders, initialBody);
    // If initial query failed and endpoint is an official service, fall back to the alternate official endpoint
    if ((status < 200 || status >= 300) && endpoint.hostname.endsWith('.googleapis.com')) {
        const alternateHost = endpoint.hostname === 'daily-cloudcode-pa.googleapis.com'
            ? 'cloudcode-pa.googleapis.com'
            : 'daily-cloudcode-pa.googleapis.com';
        try {
            const altEndpoint = new URL(endpoint.toString());
            altEndpoint.hostname = alternateHost;
            const fallbackRes = await postJson(altEndpoint, authHeaders, initialBody);
            if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
                endpoint.hostname = alternateHost;
                status = fallbackRes.status;
                data = fallbackRes.data;
            }
        }
        catch { }
    }
    if (status < 200 || status >= 300)
        throw new GoogleAccountError((0, googleAccessErrors_1.describeGoogleAccessError)(status, 'quota').message, status);
    // 2. Complementary query: if third-party (Claude/GPT) groups exist without Gemini, fetch Gemini
    let userScoped;
    const isThirdPartyGroup = Array.isArray(data.groups) &&
        data.groups.some((g) => {
            if (!g || typeof g !== 'object')
                return false;
            const name = String(g.displayName || g.name || '');
            return /claude|gpt|anthropic|openai|third[- ]?party/i.test(name);
        });
    const hasGemini = (Array.isArray(data.groups) &&
        data.groups.some((g) => {
            if (!g || typeof g !== 'object')
                return false;
            const name = String(g.displayName || g.name || '');
            return /gemini/i.test(name);
        })) ||
        (Array.isArray(data.buckets) &&
            data.buckets.some((b) => {
                if (!b || typeof b !== 'object')
                    return false;
                const text = String(b.displayName ||
                    b.id ||
                    b.bucketId ||
                    '');
                return /gemini/i.test(text);
            }));
    if (account.project && isThirdPartyGroup && !hasGemini) {
        try {
            userScoped = await postJson(endpoint, authHeaders, '{}');
        }
        catch { }
        const userScopedHasGemini = Array.isArray(userScoped?.data?.groups) &&
            userScoped.data.groups.some((g) => {
                if (!g || typeof g !== 'object')
                    return false;
                const name = String(g.displayName || g.name || '');
                return /gemini/i.test(name);
            });
        if ((!userScopedHasGemini || !userScoped || userScoped.status < 200 || userScoped.status >= 300) && endpoint.hostname !== 'cloudcode-pa.googleapis.com') {
            const prodEndpoint = new URL('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
            try {
                const prodRes = await postJson(prodEndpoint, authHeaders, JSON.stringify({ project: effectiveProject || 'aicode-consumers' }));
                if (prodRes.status >= 200 && prodRes.status < 300)
                    userScoped = prodRes;
            }
            catch { }
        }
    }
    // 3. Merge responses from this account's own Google queries and official intercepted session
    const official = (0, shared_2.getOfficialQuota)(account.email);
    let officialForThisAccount;
    if (official) {
        const offUser = official.user;
        const offEmail = String(offUser?.email || official.userEmail || official.email || '').toLowerCase().trim();
        const acctEmail = (account.email || '').toLowerCase().trim();
        if (acctEmail && offEmail && acctEmail === offEmail) {
            officialForThisAccount = official;
        }
    }
    const sourceDatasets = [data, userScoped?.data, officialForThisAccount].filter(Boolean);
    const mergedGroups = [];
    const mergedBuckets = [];
    const seenGroupNames = new Set();
    for (const ds of sourceDatasets) {
        if (Array.isArray(ds.groups)) {
            for (const g of ds.groups) {
                if (!g || typeof g !== 'object')
                    continue;
                const gRec = g;
                const gName = String(gRec.displayName || gRec.name || gRec.title || '').trim();
                const lowerName = gName.toLowerCase();
                if (!lowerName) {
                    mergedGroups.push({ ...gRec, buckets: Array.isArray(gRec.buckets) ? [...gRec.buckets] : [] });
                    continue;
                }
                if (!seenGroupNames.has(lowerName)) {
                    seenGroupNames.add(lowerName);
                    mergedGroups.push({ ...gRec, buckets: Array.isArray(gRec.buckets) ? [...gRec.buckets] : [] });
                }
                else {
                    const existingGroup = mergedGroups.find((eg) => {
                        const egName = String(eg.displayName || eg.name || eg.title || '').trim().toLowerCase();
                        return egName === lowerName;
                    });
                    if (existingGroup && Array.isArray(gRec.buckets)) {
                        if (!Array.isArray(existingGroup.buckets))
                            existingGroup.buckets = [];
                        const existingBuckets = existingGroup.buckets;
                        const seenIds = new Set(existingBuckets.map((b) => String(b.bucketId || b.id || b.displayName || '').toLowerCase().trim()));
                        for (const nb of gRec.buckets) {
                            if (!nb || typeof nb !== 'object')
                                continue;
                            const nbRec = nb;
                            const nbId = String(nbRec.bucketId || nbRec.id || nbRec.displayName || '').toLowerCase().trim();
                            const existingBucket = existingBuckets.find((b) => String(b.bucketId || b.id || b.displayName || '').toLowerCase().trim() === nbId);
                            if (existingBucket) {
                                if (ds === officialForThisAccount) {
                                    if (typeof nbRec.remainingFraction === 'number')
                                        existingBucket.remainingFraction = nbRec.remainingFraction;
                                    if (typeof nbRec.resetTime === 'string')
                                        existingBucket.resetTime = nbRec.resetTime;
                                }
                            }
                            else if (nbId && !seenIds.has(nbId)) {
                                seenIds.add(nbId);
                                existingBuckets.push(nbRec);
                            }
                        }
                    }
                }
            }
        }
        if (Array.isArray(ds.buckets)) {
            const seenBucketKeys = new Set(mergedBuckets.map((b) => `${b.bucketId || b.id || ''}::${b.displayName || ''}`));
            for (const b of ds.buckets) {
                if (b && typeof b === 'object') {
                    const bRec = b;
                    const bKey = `${bRec.bucketId || bRec.id || ''}::${bRec.displayName || ''}`;
                    const existingBucket = mergedBuckets.find((eb) => `${eb.bucketId || eb.id || ''}::${eb.displayName || ''}` === bKey);
                    if (existingBucket) {
                        if (ds === officialForThisAccount) {
                            if (typeof bRec.remainingFraction === 'number')
                                existingBucket.remainingFraction = bRec.remainingFraction;
                            if (typeof bRec.resetTime === 'string')
                                existingBucket.resetTime = bRec.resetTime;
                        }
                    }
                    else if (!seenBucketKeys.has(bKey)) {
                        seenBucketKeys.add(bKey);
                        mergedBuckets.push(bRec);
                    }
                }
            }
        }
    }
    // If userScoped had top-level buckets and no groups, ensure they appear as Gemini Models
    if (!seenGroupNames.has('gemini models') && Array.isArray(userScoped?.data?.buckets) && userScoped.data.buckets.length > 0) {
        mergedGroups.unshift({
            name: 'Gemini Models',
            displayName: 'Gemini Models',
            buckets: userScoped.data.buckets.map((b) => ({ ...b, groupName: 'Gemini Models' })),
        });
        seenGroupNames.add('gemini models');
    }
    const responseData = {
        ...(userScoped?.data || {}),
        ...data,
        groups: mergedGroups,
        ...(mergedBuckets.length ? { buckets: mergedBuckets } : {}),
    };
    const buckets = [];
    const groups = [];
    const rawGroups = [
        ...(Array.isArray(responseData.groups) ? responseData.groups : []),
        ...(Array.isArray(responseData.buckets) ? [{ buckets: responseData.buckets }] : []),
    ];
    const groupedBuckets = new Map();
    const topLevelGroup = Array.isArray(responseData.buckets) ? rawGroups[rawGroups.length - 1] : undefined;
    const sameBucket = (left, right) => {
        const normalize = (value) => value?.trim().toLowerCase() || '';
        const leftFamily = quotaFamily(`${left.groupName || ''} ${left.id} ${left.displayName || ''}`);
        const rightFamily = quotaFamily(`${right.groupName || ''} ${right.id} ${right.displayName || ''}`);
        if (leftFamily !== rightFamily)
            return false;
        for (const field of ['groupName', 'displayName', 'resetTime']) {
            if (left[field] && right[field] && normalize(left[field]) !== normalize(right[field]))
                return false;
        }
        // Flat buckets can carry the model label that the grouped response puts on its parent.
        // Sharing a family and a generic ID such as "weekly" does not prove these are the same model.
        if (left.groupName && right.displayName && normalize(left.groupName) !== normalize(right.displayName))
            return false;
        // A generic flat ID (for example "weekly") cannot establish which named group it belongs to.
        return (!!leftFamily ||
            normalize(left.groupName) === normalize(right.groupName) ||
            (!!left.displayName && normalize(left.displayName) === normalize(right.displayName)));
    };
    for (const group of rawGroups) {
        if (!group || typeof group !== 'object')
            continue;
        const groupName = typeof group.displayName === 'string' && group.displayName.trim()
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
        const groupBuckets = [];
        for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
            if (!bucket || typeof bucket !== 'object')
                continue;
            const bId = typeof bucket.bucketId === 'string' ? bucket.bucketId : typeof bucket.id === 'string' ? bucket.id : 'quota';
            const bDisplayName = typeof bucket.displayName === 'string'
                ? bucket.displayName
                : typeof bucket.title === 'string'
                    ? bucket.title
                    : typeof bucket.label === 'string'
                        ? bucket.label
                        : undefined;
            const bFraction = typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
                ? Math.max(0, Math.min(1, bucket.remainingFraction))
                : undefined;
            const bReset = typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined;
            const item = {
                id: bId,
                ...(bDisplayName ? { displayName: bDisplayName } : {}),
                ...(groupName ? { groupName } : {}),
                remainingFraction: bFraction,
                resetTime: bReset,
            };
            const explicitId = typeof bucket.bucketId === 'string' ? bucket.bucketId : bucket.id;
            const key = typeof explicitId === 'string' ? explicitId.trim().toLowerCase() : '';
            if (group === topLevelGroup && key) {
                const matches = (groupedBuckets.get(key) || []).filter((existing) => sameBucket(existing, item));
                if (matches.length === 1) {
                    const existing = matches[0];
                    const measured = [existing.remainingFraction, item.remainingFraction].filter((value) => value !== undefined);
                    existing.remainingFraction = measured.length ? Math.min(...measured) : undefined;
                    existing.displayName || (existing.displayName = item.displayName);
                    existing.resetTime || (existing.resetTime = item.resetTime);
                    continue;
                }
            }
            groupBuckets.push(item);
            buckets.push(item);
            if (group !== topLevelGroup && key)
                groupedBuckets.set(key, [...(groupedBuckets.get(key) || []), item]);
        }
        if (groupBuckets.length > 0 || groupName) {
            groups.push({
                name: groupName || 'Models',
                displayName: groupName || 'Models',
                buckets: groupBuckets,
            });
        }
    }
    const remaining = buckets.flatMap((bucket) => bucket.remainingFraction === undefined ? [] : [bucket.remainingFraction]);
    const paidTier = responseData.paidTier && typeof responseData.paidTier === 'object' ? responseData.paidTier : undefined;
    const quotaUser = responseData.user && typeof responseData.user === 'object' ? responseData.user : undefined;
    const rawTier = typeof responseData?.subscriptionTier === 'string'
        ? responseData.subscriptionTier
        : typeof responseData?.userTier === 'string'
            ? responseData.userTier
            : typeof responseData?.planTier === 'string'
                ? responseData.planTier
                : typeof paidTier?.tier === 'string'
                    ? paidTier.tier
                    : undefined;
    let planTier;
    if (rawTier) {
        const lower = rawTier.toLowerCase();
        if (lower.includes('enterprise'))
            planTier = 'Enterprise';
        else if (lower.includes('trial'))
            planTier = 'Pro Trial';
        else if (lower.includes('pro'))
            planTier = 'Pro';
        else if (lower.includes('free'))
            planTier = 'Free';
        else
            planTier = rawTier.charAt(0).toUpperCase() + rawTier.slice(1);
    }
    else if (buckets.length > 0) {
        const has5h = buckets.some((b) => {
            const text = `${b.id} ${b.displayName || ''}`.toLowerCase();
            return text.includes('5h') || text.includes('five') || /5[-_ ]?hour/.test(text);
        });
        planTier = has5h ? 'Pro' : 'Free';
    }
    let email = account.email ||
        (typeof responseData.userEmail === 'string'
            ? responseData.userEmail
            : typeof responseData.email === 'string'
                ? responseData.email
                : typeof quotaUser?.email === 'string'
                    ? quotaUser.email
                    : undefined);
    let name;
    if (!email &&
        current.accessToken &&
        options.includeIdentity &&
        (options.fetchUserInfo || endpoint.hostname.endsWith('.googleapis.com'))) {
        try {
            const info = await (options.fetchUserInfo || googleOAuth_1.fetchGoogleUserInfo)(current.accessToken, options.signal);
            if (info.email)
                email = info.email;
            if (info.name)
                name = info.name;
        }
        catch { }
    }
    if (email && !account.email) {
        account.email = email;
    }
    if (email && (!account.label || account.label.toLowerCase() === 'google account')) {
        account.label = email;
        stateFor(account).label = email;
    }
    const snapshot = {
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
async function fetchGoogleModels(account, baseURL) {
    const endpoint = new URL(googleAccountEndpoint(account, baseURL));
    endpoint.pathname = '/v1internal:fetchAvailableModels';
    endpoint.search = '';
    const current = await refreshGoogleAccount(account);
    const { status, data } = await postJson(endpoint, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${current.accessToken}`,
        'User-Agent': exports.GOOGLE_CLOUD_CODE_USER_AGENT,
    }, JSON.stringify(current.project ? { project: current.project } : {}));
    if (status < 200 || status >= 300)
        throw new GoogleAccountError((0, googleAccessErrors_1.describeGoogleAccessError)(status, 'models').message, status);
    const models = data.models || data.availableModels || data.available_models;
    if (!models || typeof models !== 'object')
        throw new GoogleAccountError('Google did not return an available model list.', 502);
    const entries = Array.isArray(models) ? models.map((value) => ['', value]) : Object.entries(models);
    const found = new Map();
    for (const [key, value] of entries) {
        if (!value || typeof value !== 'object')
            continue;
        const model = value;
        const candidate = model.id || model.name || key || model.modelId || model.model;
        if (typeof candidate !== 'string' || !candidate)
            continue;
        const id = candidate.replace(/^models\//, '');
        const displayName = typeof model.displayName === 'string' ? model.displayName : id;
        found.set(id, { id, displayName });
    }
    return [...found.values()];
}
async function acquireGoogleAccount(modelName, accounts, options = {}, requestIdentity, cooldownScope = modelName) {
    const attempted = new Set();
    const identityKey = requestIdentity
        ? (0, crypto_1.createHash)('sha256').update(`${modelName}\0${requestIdentity}`).digest('hex')
        : undefined;
    for (const [key, entry] of sticky)
        if (Date.now() - entry.at > 3600000)
            sticky.delete(key);
    if (sticky.size > 2000)
        sticky.delete(sticky.keys().next().value);
    while (attempted.size < accounts.length) {
        const now = Date.now();
        let candidates = accounts.filter((account) => {
            const state = stateFor(account);
            return (account.enabled !== false &&
                !attempted.has(poolKey(account)) &&
                !state.authState &&
                state.cooldownUntil <= now &&
                (state.modelCooldowns.get(cooldownScope)?.until ?? 0) <= now &&
                !quotaExhausted(state, now, cooldownScope) &&
                state.inFlight < (options.maxConcurrency ?? 2));
        });
        candidates = candidates.sort((left, right) => {
            const a = stateFor(left), b = stateFor(right);
            if (options.strategy === 'least-loaded' && a.inFlight !== b.inFlight)
                return a.inFlight - b.inFlight;
            if (options.strategy === 'quota') {
                const qa = quotaFraction(a, cooldownScope, now) ?? 0.5, qb = quotaFraction(b, cooldownScope, now) ?? 0.5;
                if (qa !== qb)
                    return qb - qa;
            }
            return a.lastUsed - b.lastUsed;
        });
        const stick = identityKey ? sticky.get(identityKey) : undefined;
        const stickyCandidate = stick ? candidates.find((account) => poolKey(account) === stick.accountKey) : undefined;
        const eligibleSticky = stickyCandidate && stateFor(stickyCandidate).consecutiveFailures === 0 && !stateFor(stickyCandidate).authState
            ? stickyCandidate
            : undefined;
        const selected = candidates.find((account) => account.id === options.preferredAccountId) ||
            eligibleSticky ||
            (options.strategy === 'adaptive' ? selectAdaptive(candidates, cooldownScope) : candidates[0]);
        if (!selected)
            throw new GoogleAccountError('No Google account is currently eligible: check authentication, quota, cooldown and concurrency limits.', 503);
        const key = poolKey(selected), state = stateFor(selected);
        attempted.add(key);
        state.inFlight += 1;
        state.lastUsed = ++selectionOrder;
        try {
            const updated = await refreshGoogleAccount(selected);
            if (updated.accessToken !== selected.accessToken ||
                updated.refreshToken !== selected.refreshToken ||
                updated.expiresAt !== selected.expiresAt) {
                await persistAccount?.(modelName, updated, selected);
            }
            if (identityKey)
                sticky.set(identityKey, { accountKey: key, accountId: selected.id, at: Date.now() });
            state.requests++;
            let released = false;
            return {
                account: updated,
                release(result = {}) {
                    if (released)
                        return;
                    released = true;
                    state.inFlight = Math.max(0, state.inFlight - 1);
                    if (result.cancelled)
                        return;
                    if (result.status !== undefined)
                        state.lastStatus = result.status;
                    if (result.status >= 200 && result.status < 400) {
                        state.succeeded++;
                        state.consecutiveFailures = 0;
                        if (Number.isFinite(result.latencyMs) && result.latencyMs >= 0) {
                            const previous = measuredLatency(state);
                            state.latency = {
                                average: Math.round(previous === undefined ? result.latencyMs : previous * 0.8 + result.latencyMs * 0.2),
                                measuredAt: Date.now(),
                            };
                        }
                    }
                    else if (result.status >= 400) {
                        state.failed++;
                        state.consecutiveFailures++;
                    }
                    const quotaDenial = result.status === 403 &&
                        (result.cooldownReason === 'quota-exhausted' || result.cooldownReason === 'rate-limited');
                    if (result.status === 401 || (result.status === 403 && !quotaDenial)) {
                        state.authState = result.status === 401 ? 'unauthorized' : 'forbidden';
                        tokenCache.delete(accountKey(selected));
                        tokenCache.delete(accountKey(updated));
                        for (const [sKey, entry] of sticky) {
                            if (entry.accountId === selected.id || entry.accountKey === key)
                                sticky.delete(sKey);
                        }
                    }
                    else if (quotaDenial ||
                        result.status === 408 ||
                        result.status === 429 ||
                        (result.status && result.status >= 500)) {
                        for (const [sKey, entry] of sticky) {
                            if (entry.accountId === selected.id || entry.accountKey === key)
                                sticky.delete(sKey);
                        }
                        const delay = Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0
                            ? result.retryAfterMs
                            : (options.cooldownMs ?? 60000);
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
        }
        catch (error) {
            state.inFlight = Math.max(0, state.inFlight - 1);
            if (error instanceof GoogleAccountError && [401, 403].includes(error.status))
                state.authState = error.status === 401 ? 'unauthorized' : 'forbidden';
            else
                state.cooldownUntil = Date.now() + (options.cooldownMs ?? 60000);
        }
    }
    throw new GoogleAccountError('No Google account could authenticate; reconnect an account or check its OAuth client configuration.', 401);
}
function recordGoogleAccountFailure(account, status, retryAfterMs, cooldownScope, reason) {
    const state = stateFor(account);
    state.failed++;
    state.consecutiveFailures++;
    state.lastStatus = status;
    for (const [sKey, entry] of sticky) {
        if (entry.accountId === account.id || entry.accountKey === poolKey(account))
            sticky.delete(sKey);
    }
    const quotaDenial = status === 403 && (reason === 'quota-exhausted' || reason === 'rate-limited');
    if (status === 401 || (status === 403 && !quotaDenial)) {
        state.authState = status === 401 ? 'unauthorized' : 'forbidden';
        tokenCache.delete(accountKey(account));
    }
    else if (quotaDenial || status === 408 || status === 429 || (status && status >= 500)) {
        const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 60000;
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
function getGooglePoolStatus() {
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
            status: state.authState ||
                (quotaExhausted(state, now) ? 'quota-exhausted' : cooldownUntil > now ? 'cooldown' : 'ready'),
            cooldownUntil,
            modelCooldowns,
            requests: state.requests,
            succeeded: state.succeeded,
            failed: state.failed,
            avgLatencyMs: measuredLatency(state, now),
            lastStatus: state.lastStatus,
            lastError: state.lastStatus >= 400
                ? (0, googleAccessErrors_1.describeGoogleAccessError)(state.lastStatus === 403 &&
                    !state.authState &&
                    modelCooldowns.some((cooldown) => cooldown.reason === 'rate-limited' || cooldown.reason === 'quota-exhausted')
                    ? 429
                    : state.lastStatus)
                : undefined,
            quotaAgeMs: state.quota ? Math.max(0, now - state.quota.checkedAt) : undefined,
            quotaFresh: quotaIsFresh(state.quota, now),
            quotaExhausted: quotaExhausted(state, now),
            quota: state.quota,
        };
    });
}
/** Clear volatile account state after explicit account edits or sign-in. */
function resetGoogleAccountState(id) {
    for (const [key, state] of poolStates)
        if (!id || state.id === id)
            poolStates.delete(key);
    for (const [key, account] of tokenCache)
        if (!id || account.id === id)
            tokenCache.delete(key);
    if (!id) {
        tokenCache.clear();
        sticky.clear();
    }
    else {
        for (const [key, entry] of sticky) {
            if (entry.accountId === id || entry.accountKey === id)
                sticky.delete(key);
        }
    }
}
//# sourceMappingURL=googleAccounts.js.map