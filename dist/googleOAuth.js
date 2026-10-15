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
exports.GOOGLE_TOKEN_URL = exports.GOOGLE_AUTHORIZATION_URL = void 0;
exports.parseGoogleIdToken = parseGoogleIdToken;
exports.fetchGoogleUserInfo = fetchGoogleUserInfo;
exports.loginGoogleAccount = loginGoogleAccount;
/** Explicit Google desktop OAuth login with PKCE and a fresh loopback callback per attempt. */
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_crypto_1 = require("node:crypto");
const googleAccessErrors_1 = require("./googleAccessErrors");
const googleNativeClient_1 = require("./googleNativeClient");
exports.GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
exports.GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform';
function parseGoogleIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string')
        return undefined;
    const parts = idToken.split('.');
    if (parts.length < 2)
        return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const email = typeof payload?.email === 'string' && payload.email ? payload.email : undefined;
        const name = typeof payload?.name === 'string' && payload.name ? payload.name : undefined;
        if (email || name)
            return { email, name };
    }
    catch { }
    return undefined;
}
function fetchGoogleUserInfo(accessToken, signal) {
    return new Promise((resolve) => {
        if (!accessToken || signal?.aborted) {
            resolve({});
            return;
        }
        let settled = false;
        const finish = (val = {}) => {
            if (settled)
                return;
            settled = true;
            if (signal)
                signal.removeEventListener('abort', onAbort);
            resolve(val);
        };
        const onAbort = () => {
            try {
                req?.destroy?.();
            }
            catch { }
            finish({});
        };
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
        let req;
        try {
            req = https.request('https://www.googleapis.com/oauth2/v2/userinfo', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    'User-Agent': 'antigravity-add-model',
                },
            }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > 64 * 1024) {
                        try {
                            res.destroy();
                        }
                        catch { }
                        finish({});
                    }
                    else
                        chunks.push(c);
                });
                res.on('error', () => finish({}));
                res.on('end', () => {
                    try {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            const email = typeof data?.email === 'string' && data.email ? data.email : undefined;
                            const name = typeof data?.name === 'string' && data.name ? data.name : undefined;
                            finish({ email, name });
                            return;
                        }
                    }
                    catch { }
                    finish({});
                });
            });
            if (!req) {
                finish({});
                return;
            }
            req.on('error', () => finish({}));
            req.setTimeout(5000, () => {
                try {
                    req.destroy();
                }
                catch { }
                finish({});
            });
            req.end();
        }
        catch {
            finish({});
        }
    });
}
function cancellation(message = 'Google login cancelled') {
    return Object.assign(new Error(message), { name: 'AbortError' });
}
function exchangeToken(parameters, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(cancellation());
            return;
        }
        const body = parameters.toString();
        let settled = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', abort);
            if (error)
                reject(error);
            else
                resolve(value);
        };
        const req = https.request(exports.GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                Accept: 'application/json',
            },
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 256 * 1024) {
                    finish(new Error('Google token response exceeded the size limit'));
                    res.destroy();
                    req.destroy();
                }
                else
                    chunks.push(chunk);
            });
            res.on('aborted', () => finish(new Error('Google token exchange ended unexpectedly')));
            res.on('error', () => finish(new Error('Google token exchange failed')));
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    finish(new Error((0, googleAccessErrors_1.describeGoogleAccessError)(res.statusCode || 502, 'oauth').message));
                    return;
                }
                try {
                    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384)
                        throw new Error();
                    if (value.refresh_token !== undefined &&
                        (typeof value.refresh_token !== 'string' || value.refresh_token.length > 16384))
                        throw new Error();
                    finish(undefined, value);
                }
                catch {
                    finish(new Error('Google returned an invalid token response'));
                }
            });
        });
        const abort = () => {
            finish(cancellation());
            req.destroy();
        };
        signal.addEventListener('abort', abort, { once: true });
        req.on('error', () => finish(new Error('Could not connect to Google to complete login')));
        req.setTimeout(30000, () => {
            finish(new Error('Google token exchange timed out'));
            req.destroy();
        });
        req.end(body);
    });
}
/** Returns credentials to the main process only. IPC callers must store them before returning a redacted account. */
async function loginGoogleAccount(options, openExternal, dependencies = {}) {
    if (options.signal?.aborted)
        throw cancellation();
    if (options.authMode !== undefined && options.authMode !== 'custom' && options.authMode !== 'antigravity')
        throw new Error('Choose Antigravity sign-in or Custom Desktop OAuth.');
    const native = options.authMode === 'antigravity' ? (dependencies.resolveNativeClient || googleNativeClient_1.resolveGoogleNativeClient)() : undefined;
    const clientId = (native?.clientId ?? options.clientId)?.trim();
    const clientSecret = (native?.clientSecret ?? options.clientSecret)?.trim();
    // Match the recognized vendor client's registered callback while listening only on IPv4 loopback.
    const callbackHost = native ? 'localhost' : '127.0.0.1';
    const callbackPath = native ? '/oauth-callback' : '/oauth2callback';
    if (!clientId || !/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 512) {
        throw new Error('Enter your Google Desktop OAuth client ID (.apps.googleusercontent.com).');
    }
    if (clientSecret && (clientSecret.length > 2048 || /\s/.test(clientSecret)))
        throw new Error('OAuth client secret is invalid');
    if (options.signal?.aborted)
        throw cancellation();
    const timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000)
        throw new Error('OAuth timeout must be between 1 and 600000 milliseconds');
    const state = (0, node_crypto_1.randomBytes)(32).toString('base64url');
    const verifier = (0, node_crypto_1.randomBytes)(64).toString('base64url');
    const challenge = (0, node_crypto_1.createHash)('sha256').update(verifier).digest('base64url');
    const tokenController = new AbortController();
    return new Promise((resolve, reject) => {
        let finished = false, exchanging = false;
        let redirectUri = '';
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            tokenController.abort();
            server.close();
            server.closeIdleConnections();
        };
        const finish = (error, account) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            if (error)
                reject(error);
            else
                resolve(account);
        };
        const onAbort = () => finish(cancellation());
        const server = http.createServer((req, res) => {
            const reply = (status, text) => {
                res.writeHead(status, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy': "default-src 'none'",
                    'Referrer-Policy': 'no-referrer',
                    Connection: 'close',
                });
                res.end(text);
            };
            if (finished || !redirectUri) {
                reply(410, 'This login attempt has ended.');
                return;
            }
            if (req.method !== 'GET' || (req.url?.length || 0) > 8192) {
                reply(405, 'Unsupported callback request.');
                return;
            }
            let callback;
            try {
                callback = new URL(req.url || '/', redirectUri);
            }
            catch {
                reply(400, 'Invalid callback.');
                return;
            }
            const expected = new URL(redirectUri);
            if (req.headers.host !== expected.host ||
                callback.origin !== expected.origin ||
                callback.pathname !== callbackPath) {
                reply(404, 'Not found.');
                return;
            }
            const receivedState = callback.searchParams.get('state') || '';
            if (callback.searchParams.getAll('state').length !== 1 ||
                receivedState.length !== state.length ||
                !/^[A-Za-z0-9_-]+$/.test(receivedState) ||
                !(0, node_crypto_1.timingSafeEqual)(Buffer.from(receivedState), Buffer.from(state))) {
                reply(400, 'Login state did not match. Continue using the browser window opened by the application.');
                return;
            }
            if (callback.searchParams.has('error')) {
                reply(400, 'Google login was not approved. You can close this page.');
                finish(new Error('Google login was denied or cancelled.'));
                return;
            }
            const code = callback.searchParams.get('code');
            if (!code || code.length > 4096 || callback.searchParams.getAll('code').length !== 1) {
                reply(400, 'Authorization code is missing or invalid.');
                return;
            }
            if (exchanging) {
                reply(409, 'Login is already being completed.');
                return;
            }
            exchanging = true;
            const parameters = new URLSearchParams({
                client_id: clientId,
                code,
                code_verifier: verifier,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            });
            if (clientSecret)
                parameters.set('client_secret', clientSecret);
            void (dependencies.exchangeToken || exchangeToken)(parameters, tokenController.signal)
                .then(async (tokens) => {
                if (finished) {
                    reply(410, 'This login attempt has ended.');
                    return;
                }
                if (!tokens.access_token || typeof tokens.access_token !== 'string')
                    throw new Error('Google did not return an access token');
                const seconds = Number(tokens.expires_in);
                const expiresIn = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 3600;
                let identity = parseGoogleIdToken(tokens.id_token);
                if (!identity?.email && tokens.access_token) {
                    try {
                        const info = await fetchGoogleUserInfo(tokens.access_token, tokenController.signal);
                        if (info.email || info.name) {
                            identity = { ...identity, ...info };
                        }
                    }
                    catch { }
                }
                const email = identity?.email;
                const actualName = identity?.name;
                const userLabel = options.label?.trim();
                const isGeneric = !userLabel || userLabel.toLowerCase() === 'google account';
                const label = !isGeneric ? userLabel : (email || actualName || 'Google account');
                reply(200, 'Google login completed. Return to Antigravity and save the model to retain this account. You can close this page.');
                finish(undefined, {
                    authMode: options.authMode || 'custom',
                    id: (0, node_crypto_1.randomUUID)(),
                    label,
                    ...(email ? { email } : {}),
                    accessToken: tokens.access_token,
                    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
                    expiresAt: (dependencies.now || Date.now)() + expiresIn * 1000,
                    clientId,
                    ...(clientSecret ? { clientSecret } : {}),
                });
            })
                .catch((error) => {
                reply(502, 'Login could not be completed. Return to the application for details.');
                finish(error instanceof Error ? error : new Error('Google login failed'));
            });
        });
        server.headersTimeout = 10000;
        server.requestTimeout = 10000;
        server.keepAliveTimeout = 1000;
        server.maxConnections = 8;
        server.on('connection', (socket) => socket.setTimeout(10000, () => socket.destroy()));
        server.on('error', () => finish(new Error('Could not open the local Google login callback')));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(cancellation('Google login timed out. Start login again.')), timeoutMs);
        server.listen(0, '127.0.0.1', () => {
            if (finished) {
                server.close();
                return;
            }
            const address = server.address();
            if (!address || typeof address === 'string') {
                finish(new Error('Google login callback did not start'));
                return;
            }
            redirectUri = `http://${callbackHost}:${address.port}${callbackPath}`;
            const authorization = new URL(exports.GOOGLE_AUTHORIZATION_URL);
            authorization.search = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: native ? native.scopes.join(' ') : SCOPES,
                access_type: 'offline',
                prompt: 'select_account consent',
                state,
                code_challenge: challenge,
                code_challenge_method: 'S256',
            }).toString();
            void Promise.resolve()
                .then(() => openExternal(authorization.toString()))
                .catch(() => finish(new Error('Could not open the browser for Google login')));
        });
    });
}
//# sourceMappingURL=googleOAuth.js.map