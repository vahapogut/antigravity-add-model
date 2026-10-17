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
exports.resolveGoogleFailoverPool = resolveGoogleFailoverPool;
exports.isGoogleQuotaFailure = isGoogleQuotaFailure;
exports.attemptGooglePoolFailover = attemptGooglePoolFailover;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const googleAccounts_1 = require("../googleAccounts");
const googlePoolPolicy_1 = require("../googlePoolPolicy");
const nativeSubagentResponse_1 = require("./nativeSubagentResponse");
const ERROR_LIMIT = 64 * 1024;
function parsedRequest(body) {
    try {
        const value = JSON.parse(body.toString('utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function extractModelName(body, reqUrl) {
    if (body) {
        const parsed = parsedRequest(body);
        if (typeof parsed?.model === 'string')
            return parsed.model;
        if (typeof parsed?.modelId === 'string')
            return parsed.modelId;
        if (typeof parsed?.model_id === 'string')
            return parsed.model_id;
        if (parsed?.request && typeof parsed.request === 'object') {
            const inner = parsed.request;
            if (typeof inner.model === 'string')
                return inner.model;
            if (typeof inner.modelId === 'string')
                return inner.modelId;
            if (typeof inner.model_id === 'string')
                return inner.model_id;
        }
    }
    if (reqUrl) {
        const match = reqUrl.match(/\/(?:v1|v1beta)\/models\/([^:]+)/);
        if (match) {
            try {
                return decodeURIComponent(match[1]);
            }
            catch {
                return match[1];
            }
        }
    }
    return undefined;
}
function quotaFamily(name) {
    if (/claude|gpt|anthropic|openai|third[- ]?party/i.test(name))
        return 'third-party';
    if (/gemini|google|flash|pro/i.test(name))
        return 'gemini';
    return undefined;
}
/** Helper to strip model URI and cloudcode prefixes cleanly. */
function cleanModelName(val) {
    return val
        .replace(/^(?:models\/)?(?:google[-_ ]?cloudcode\/)?/i, '')
        .trim();
}
/** No global credential aggregation: only one explicitly opted-in matching model is eligible. */
function resolveGoogleFailoverPool(models, body, reqUrl) {
    const rawModel = extractModelName(body, reqUrl);
    if (!rawModel)
        return undefined;
    const upstream = cleanModelName(rawModel);
    const lowerUpstream = upstream.toLowerCase();
    const eligible = models.filter((model) => model.enabled !== false &&
        model.provider === 'google-cloudcode' &&
        model.googlePool?.nativeFailoverEnabled === true &&
        model.googleAccounts?.some((account) => account.enabled !== false));
    if (!eligible.length)
        return undefined;
    // 1. Exact match (case-sensitive)
    const exact = eligible.filter((model) => cleanModelName(model.externalModelName || model.name) === upstream);
    if (exact.length === 1)
        return exact[0];
    if (exact.length > 1)
        return undefined;
    // 2. Case-insensitive exact match
    const caseExact = eligible.filter((model) => cleanModelName(model.externalModelName || model.name).toLowerCase() === lowerUpstream);
    if (caseExact.length === 1)
        return caseExact[0];
    if (caseExact.length > 1)
        return undefined;
    // 3. Normalized slug matching (handles date tags, preview, thinking, etc.)
    const normalize = (val) => cleanModelName(val)
        .toLowerCase()
        .replace(/[-_]?(?:thinking|thought)/i, '')
        .replace(/[@_-](?:202\d{5}|preview|latest|default).*/i, '')
        .replace(/[^a-z0-9]/g, '');
    const targetNorm = normalize(upstream);
    const slugMatches = eligible.filter((model) => {
        const extNorm = model.externalModelName ? normalize(model.externalModelName) : '';
        const nameNorm = normalize(model.name);
        return extNorm === targetNorm || nameNorm === targetNorm;
    });
    if (slugMatches.length === 1)
        return slugMatches[0];
    if (slugMatches.length > 1)
        return undefined;
    // 4. Model family matching
    const targetFamily = quotaFamily(upstream);
    if (targetFamily) {
        const familyMatches = eligible.filter((model) => {
            const extFamily = model.externalModelName ? quotaFamily(model.externalModelName) : undefined;
            const nameFamily = quotaFamily(model.name);
            return extFamily === targetFamily || nameFamily === targetFamily;
        });
        if (familyMatches.length === 1)
            return familyMatches[0];
    }
    return undefined;
}
/** HTTP 429, 403, and 400 are quota failures if structured or containing rate limit text. */
function isGoogleQuotaFailure(status, body) {
    if (status === 429)
        return true;
    if (status !== 403 && status !== 400)
        return false;
    try {
        const value = JSON.parse(body);
        const error = value?.error || value;
        if (error?.status === 'RESOURCE_EXHAUSTED')
            return true;
        if (Array.isArray(error?.details) &&
            error.details.some((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
                typeof detail.reason === 'string' &&
                /^(?:RATE_LIMIT_EXCEEDED|QUOTA_EXCEEDED|QUOTA_EXHAUSTED|DAILY_LIMIT_EXCEEDED|WEEKLY_LIMIT_EXCEEDED)$/.test(detail.reason)))
            return true;
        const msg = typeof error?.message === 'string' ? error.message : '';
        if (/permission\s+denied\s+to\s+inspect/i.test(msg)) {
            return false;
        }
        if (/quota\s*(?:limit\s*)?(?:exceeded|reached)|individual\s*quota|rate\s*limit\s*(?:exceeded|reached)|resource(?:_has_been|_is)?\s*exhausted|upgrade\s*your\s*subscription|resets\s*in/i.test(msg || body)) {
            return true;
        }
        return false;
    }
    catch {
        return /quota\s*(?:limit\s*)?(?:exceeded|reached)|individual\s*quota|rate\s*limit\s*(?:exceeded|reached)|resource(?:_has_been|_is)?\s*exhausted|upgrade\s*your\s*subscription|resets\s*in/i.test(body);
    }
}
/** Retry matching native Google requests only before downstream response headers are sent. */
async function attemptGooglePoolFailover(req, res, reqBody, errorRes, errorBody, options, nativeSubagent, cloudCodeOrigin = 'https://daily-cloudcode-pa.googleapis.com') {
    const unavailable = () => res.destroyed || res.writableEnded || options.isStopping?.();
    if (unavailable())
        return true;
    if (!isGoogleQuotaFailure(errorRes.statusCode || 500, errorBody))
        return false;
    options.log?.info(`[Failover] Detected Google quota failure (status ${errorRes.statusCode}) for ${req.url}`);
    const pool = resolveGoogleFailoverPool(options.loadCustomModels(), reqBody, req.url);
    const body = parsedRequest(reqBody) || {};
    let upstreamModel = typeof body.model === 'string' ? body.model.replace(/^models\//, '') : undefined;
    if (!upstreamModel && body.request && typeof body.request.model === 'string') {
        upstreamModel = String(body.request.model).replace(/^models\//, '');
    }
    if (!upstreamModel && req.url) {
        const match = req.url.match(/\/(?:v1|v1beta)\/models\/([^:]+)/);
        if (match)
            upstreamModel = decodeURIComponent(match[1]).replace(/^models\//, '');
    }
    if (!upstreamModel && pool) {
        upstreamModel = pool.externalModelName || cleanModelName(pool.name);
    }
    if (!pool || !upstreamModel) {
        options.log?.info(`[Failover] No eligible pool found (pool: ${pool?.name}, upstreamModel: ${upstreamModel})`);
        return false;
    }
    const originalToken = String(req.headers.authorization || '')
        .replace(/^Bearer\s+/i, '')
        .trim();
    const failingAccount = pool.googleAccounts.find((account) => account.accessToken === originalToken);
    const decision = (0, googlePoolPolicy_1.classifyGoogleRateLimit)(errorBody, errorRes.headers['retry-after']);
    if (failingAccount)
        (0, googleAccounts_1.recordGoogleAccountFailure)(failingAccount, errorRes.statusCode, decision.retryAfterMs ?? pool.googlePool?.cooldownMs, upstreamModel, decision.reason);
    let candidates = pool.googleAccounts.filter((account) => account.enabled !== false && account.id !== failingAccount?.id);
    options.log?.info(`[Failover] Pool ${pool.name} resolved with ${candidates.length} candidate standby account(s)`);
    if (!candidates.length)
        return false;
    const identity = typeof body.sessionId === 'string'
        ? body.sessionId
        : typeof body.conversationId === 'string'
            ? body.conversationId
            : undefined;
    const controller = new AbortController();
    const cancel = () => {
        if (!res.writableFinished)
            controller.abort();
    };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? pool.retryBudgetMs ?? pool.timeout ?? 60000);
    let abandonAcquire;
    try {
        const maximum = Math.min(3, candidates.length);
        for (let attempt = 0; attempt < maximum && candidates.length; attempt++) {
            if (unavailable() || controller.signal.aborted)
                return !!unavailable();
            options.log?.info(`[Failover] Attempt ${attempt + 1}/${maximum}: acquiring account from ${candidates.length} candidates...`);
            let lease;
            // Refresh can be shared by other requests. Cancel our waiter without cancelling their refresh.
            try {
                lease = await new Promise((resolve, reject) => {
                    let abandoned = false;
                    const cancelAcquire = () => {
                        abandoned = true;
                        resolve(undefined);
                    };
                    abandonAcquire = cancelAcquire;
                    controller.signal.addEventListener('abort', cancelAcquire, { once: true });
                    void (0, googleAccounts_1.acquireGoogleAccount)(pool.name, candidates, pool.googlePool, identity, upstreamModel).then((value) => {
                        controller.signal.removeEventListener('abort', cancelAcquire);
                        if (abandoned || unavailable() || controller.signal.aborted) {
                            value.release({ cancelled: true });
                            resolve(undefined);
                        }
                        else
                            resolve(value);
                    }, (error) => {
                        controller.signal.removeEventListener('abort', cancelAcquire);
                        reject(error);
                    });
                });
            }
            catch (err) {
                options.log?.warn(`[Failover] acquireGoogleAccount error:`, err);
                return false;
            }
            finally {
                abandonAcquire = undefined;
            }
            if (!lease) {
                options.log?.warn(`[Failover] Could not lease candidate account for attempt ${attempt + 1}`);
                return !!unavailable();
            }
            if (unavailable() || controller.signal.aborted) {
                lease.release({ cancelled: true });
                return !!unavailable();
            }
            options.log?.info(`[Failover] Leased standby account: ${lease.account.email || lease.account.id}`);
            let target;
            let retryBody;
            let headers;
            try {
                const origin = (0, googleAccounts_1.googleAccountEndpoint)(lease.account, pool.apiUrl || cloudCodeOrigin);
                target = new URL(req.url || '', origin);
                const isStream = target.pathname.includes('streamGenerateContent') || target.searchParams.get('alt') === 'sse';
                if (target.pathname.startsWith('/v1beta/models/') || target.pathname.startsWith('/v1/models/')) {
                    target.pathname = `/v1internal:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
                    target.search = isStream ? '?alt=sse' : '';
                }
                if (target.origin !== new URL(origin).origin ||
                    !/^\/v1internal:(?:streamGenerateContent|generateContent)$/.test(target.pathname))
                    throw new Error('Unsupported native generation path');
                headers = options.forwardingHeaders(req.headers);
                headers.host = target.host;
                headers.authorization = `Bearer ${lease.account.accessToken}`;
                // Never carry billing project header into another account.
                delete headers['x-goog-user-project'];
                const cloned = JSON.parse(JSON.stringify(body));
                delete cloned.project;
                if (lease.account.project) {
                    cloned.project = lease.account.project;
                }
                if (pool.externalModelName) {
                    cloned.model = pool.externalModelName;
                }
                else if (!cloned.model) {
                    cloned.model = upstreamModel;
                }
                retryBody = Buffer.from(JSON.stringify(cloned));
                headers['content-length'] = String(retryBody.length);
                headers['accept-encoding'] = 'identity';
            }
            catch (err) {
                options.log?.warn('[Failover] Error preparing failover payload:', err);
                lease.release({ cancelled: true });
                return false;
            }
            const selectedLease = lease;
            const started = Date.now();
            options.log?.info(`[Failover] Forwarding failover request to ${target.origin}${target.pathname}`);
            const handled = await new Promise((resolve) => {
                let settled = false;
                let request;
                let response;
                const finish = (handled, result) => {
                    if (settled)
                        return;
                    settled = true;
                    controller.signal.removeEventListener('abort', abort);
                    selectedLease.release(result);
                    resolve(handled);
                };
                const fail = () => {
                    if (settled)
                        return;
                    const sent = res.headersSent;
                    finish(sent || !!unavailable(), { status: 502, cancelled: !!unavailable() });
                    if (sent && !res.destroyed && !res.writableEnded)
                        res.destroy();
                    response?.destroy();
                    request?.destroy();
                };
                const abort = () => {
                    if (settled)
                        return;
                    const sent = res.headersSent;
                    finish(sent || !!unavailable(), { cancelled: true });
                    if (sent && !res.destroyed && !res.writableEnded)
                        res.destroy();
                    response?.destroy();
                    request?.destroy();
                };
                controller.signal.addEventListener('abort', abort, { once: true });
                try {
                    request = (options.requestFn || (target.protocol === 'http:' ? http.request : https.request))(target, { method: req.method, headers }, (upstream) => {
                        response = upstream;
                        if (settled || unavailable() || controller.signal.aborted) {
                            abort();
                            upstream.destroy();
                            return;
                        }
                        upstream.once('error', fail);
                        upstream.once('aborted', fail);
                        upstream.once('close', () => {
                            if (!upstream.complete)
                                fail();
                        });
                        const status = upstream.statusCode || 502;
                        options.log?.info(`[Failover] Upstream status: ${status} from account ${selectedLease.account.email || selectedLease.account.id}`);
                        if (status !== 200) {
                            const chunks = [];
                            let size = 0;
                            upstream.on('data', (chunk) => {
                                size += chunk.length;
                                if (size > ERROR_LIMIT)
                                    fail();
                                else
                                    chunks.push(chunk);
                            });
                            upstream.once('end', () => {
                                const text = Buffer.concat(chunks).toString('utf8');
                                const limited = isGoogleQuotaFailure(status, text);
                                const limit = limited ? (0, googlePoolPolicy_1.classifyGoogleRateLimit)(text, upstream.headers['retry-after']) : undefined;
                                options.log?.warn(`[Failover] Account ${selectedLease.account.email || selectedLease.account.id} failed upstream (${status}): ${text.substring(0, 300)}`);
                                finish(false, { status, retryAfterMs: limit?.retryAfterMs, cooldownReason: limit?.reason });
                            });
                            return;
                        }
                        const success = () => {
                            options.log?.info(`[Failover] Succeeded! Served response via standby account ${selectedLease.account.email || selectedLease.account.id}`);
                            finish(true, { status, latencyMs: Date.now() - started });
                        };
                        if (nativeSubagent) {
                            void (0, nativeSubagentResponse_1.forwardNativeGeneration)(upstream, res, nativeSubagent, target.pathname.includes('streamGenerateContent') || target.searchParams.get('alt') === 'sse').then(success, fail);
                        }
                        else {
                            upstream.once('end', success);
                            res.writeHead(status, options.forwardingHeaders(upstream.headers));
                            upstream.pipe(res);
                        }
                    });
                    request.once('error', (err) => {
                        options.log?.warn('[Failover] Upstream request error:', err);
                        fail();
                    });
                    options.trackUpstream?.(request);
                    if (controller.signal.aborted || unavailable())
                        abort();
                    if (!settled)
                        request.end(retryBody);
                }
                catch (err) {
                    options.log?.warn('[Failover] Error initiating upstream request:', err);
                    fail();
                }
            });
            if (handled)
                return true;
            candidates = candidates.filter((account) => account.id !== selectedLease.account.id);
        }
        options.log?.warn(`[Failover] All candidates exhausted for pool ${pool.name}`);
        return false;
    }
    finally {
        clearTimeout(timeout);
        res.off('close', cancel);
        abandonAcquire?.();
    }
}
//# sourceMappingURL=googlePoolFailover.js.map