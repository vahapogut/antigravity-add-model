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
exports.attemptGooglePoolFailover = attemptGooglePoolFailover;
const https = __importStar(require("node:https"));
const node_url_1 = require("node:url");
const googleAccounts_1 = require("../googleAccounts");
const googlePoolPolicy_1 = require("../googlePoolPolicy");
const nativeSubagentResponse_1 = require("./nativeSubagentResponse");
/**
 * Intercepts Google Cloud Code 429 (Resource Exhausted / Rate Limit) errors during
 * generation requests and attempts transparent failover to standby accounts configured
 * in the user's Google Account Pool.
 *
 * Returns true if failover was handled (successfully streamed standby response or completed),
 * or false if failover could not be performed (no pool, not rate-limited, or all exhausted).
 */
async function attemptGooglePoolFailover(req, res, reqBody, errorRes, errorBody, options, nativeSubagent, cloudCodeOrigin) {
    if (res.destroyed || res.writableEnded)
        return true;
    const status = errorRes.statusCode || 500;
    // Failover specifically on 429 Too Many Requests / Quota Exceeded, or 403 quota exhaustion
    const isRateLimit = status === 429 ||
        (status === 403 &&
            (errorBody.includes('RESOURCE_EXHAUSTED') ||
                errorBody.includes('quota') ||
                errorBody.includes('Rate limit exceeded')));
    if (!isRateLimit)
        return false;
    const models = options.loadCustomModels();
    const poolAccounts = [];
    let poolConfig;
    let poolModelName = 'models/google-pool';
    for (const m of models) {
        if (Array.isArray(m.googleAccounts) && m.googleAccounts.length > 0) {
            if (!poolConfig && m.googlePool)
                poolConfig = m.googlePool;
            poolModelName = m.name;
            for (const a of m.googleAccounts) {
                if (!poolAccounts.some((existing) => existing.id === a.id)) {
                    poolAccounts.push(a);
                }
            }
        }
    }
    if (poolAccounts.length === 0)
        return false;
    const decision = (0, googlePoolPolicy_1.classifyGoogleRateLimit)(errorBody, errorRes.headers['retry-after']);
    // Extract the failing token from authorization header to identify the account
    const authHeader = String(req.headers['authorization'] || '');
    const currentToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const failingAccount = poolAccounts.find((a) => a.accessToken && a.accessToken === currentToken);
    let parsedBody;
    try {
        if (reqBody.length > 0) {
            parsedBody = JSON.parse(reqBody.toString('utf8'));
        }
    }
    catch {
        // Non-JSON or empty
    }
    const requestedModel = (typeof parsedBody?.model === 'string' ? parsedBody.model : undefined) ||
        poolModelName;
    const sessionId = (typeof parsedBody?.sessionId === 'string' ? parsedBody.sessionId : undefined) ||
        (typeof parsedBody?.conversationId === 'string' ? parsedBody.conversationId : undefined) ||
        (typeof parsedBody?.request?.sessionId === 'string'
            ? (parsedBody?.request).sessionId
            : undefined);
    if (failingAccount) {
        (0, googleAccounts_1.recordGoogleAccountFailure)(failingAccount, status, decision.retryAfterMs, requestedModel, decision.reason);
        options.log?.info?.(`[Proxy] Active Google account "${failingAccount.label || failingAccount.id}" rate-limited (${status}). Cooldown: ${decision.retryAfterMs ?? 60000}ms.`);
    }
    let candidates = poolAccounts.filter((a) => a.enabled !== false && a.id !== failingAccount?.id);
    if (candidates.length === 0) {
        options.log?.warn?.('[Proxy] No standby Google accounts available in pool for failover.');
        return false;
    }
    const maxAttempts = Math.min(3, candidates.length);
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt++;
        if (res.destroyed || res.writableEnded)
            return true;
        let lease;
        try {
            lease = await (0, googleAccounts_1.acquireGoogleAccount)(requestedModel, candidates, poolConfig, sessionId, requestedModel);
        }
        catch (err) {
            options.log?.warn?.('[Proxy] Could not acquire standby Google account lease:', err);
            break;
        }
        options.log?.info?.(`[Proxy] Failing over to standby Google account "${lease.account.label || lease.account.id}" (attempt ${attempt}/${maxAttempts})...`);
        const targetOrigin = (0, googleAccounts_1.googleAccountEndpoint)(lease.account, options.cloudCodeRouting?.resolve(req.headers) || cloudCodeOrigin || 'https://daily-cloudcode-pa.googleapis.com');
        const parsedUrl = new node_url_1.URL(req.url, targetOrigin);
        const retryHeaders = options.forwardingHeaders(req.headers);
        retryHeaders['host'] = parsedUrl.host;
        retryHeaders['authorization'] = `Bearer ${lease.account.accessToken}`;
        if (lease.account.project) {
            retryHeaders['x-goog-user-project'] = lease.account.project;
        }
        let retryBody = reqBody;
        if (parsedBody && typeof parsedBody === 'object') {
            const cloned = { ...parsedBody };
            if (lease.account.project) {
                cloned.project = lease.account.project;
            }
            retryBody = Buffer.from(JSON.stringify(cloned), 'utf8');
        }
        retryHeaders['content-length'] = String(retryBody.length);
        if (nativeSubagent)
            retryHeaders['accept-encoding'] = 'identity';
        const isStreamHint = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
        const startedAt = Date.now();
        const outcome = await new Promise((resolve) => {
            const standbyReq = (options.requestFn || https.request)(parsedUrl, { method: req.method, headers: retryHeaders }, async (standbyRes) => {
                const sc = standbyRes.statusCode || 200;
                if (sc >= 200 && sc < 300) {
                    lease.release({ status: sc, latencyMs: Date.now() - startedAt });
                    options.log?.info?.(`[Proxy] Standby account "${lease.account.label || lease.account.id}" succeeded with status ${sc}.`);
                    if (nativeSubagent) {
                        try {
                            await (0, nativeSubagentResponse_1.forwardNativeGeneration)(standbyRes, res, nativeSubagent, isStreamHint);
                        }
                        catch (e) {
                            options.log?.error?.('[Proxy] Standby native generation forwarding failed:', e);
                        }
                    }
                    else {
                        res.writeHead(sc, options.forwardingHeaders(standbyRes.headers));
                        standbyRes.pipe(res);
                    }
                    resolve({ handled: true, succeeded: true });
                }
                else if (sc === 429 || sc === 403) {
                    const subChunks = [];
                    standbyRes.on('data', (c) => {
                        if (subChunks.length < 16)
                            subChunks.push(c);
                    });
                    standbyRes.on('end', () => {
                        const subBody = Buffer.concat(subChunks).toString('utf8');
                        const subDecision = (0, googlePoolPolicy_1.classifyGoogleRateLimit)(subBody, standbyRes.headers['retry-after']);
                        lease.release({
                            status: sc,
                            retryAfterMs: subDecision.retryAfterMs,
                            cooldownReason: subDecision.reason,
                        });
                        resolve({ handled: false, succeeded: false });
                    });
                }
                else {
                    // Other status code (e.g. 400 or 500)
                    lease.release({ status: sc });
                    res.writeHead(sc, options.forwardingHeaders(standbyRes.headers));
                    standbyRes.pipe(res);
                    resolve({ handled: true, succeeded: false });
                }
            });
            standbyReq.on('error', (err) => {
                options.log?.error?.('[Proxy] Standby request error:', err);
                lease.release({ status: 502 });
                resolve({ handled: false, succeeded: false });
            });
            res.once('close', () => {
                standbyReq.destroy();
                lease.release({ cancelled: true });
            });
            standbyReq.end(retryBody);
        });
        if (outcome.handled) {
            return true;
        }
        // Exclude the account that just failed and loop
        candidates = candidates.filter((a) => a.id !== lease.account.id);
    }
    return false;
}
//# sourceMappingURL=googlePoolFailover.js.map