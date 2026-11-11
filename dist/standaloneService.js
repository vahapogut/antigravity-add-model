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
exports.startStandaloneService = startStandaloneService;
/** Owned loopback service for the IDE adapter and browser model manager. */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const browserLauncher_1 = require("./browserLauncher");
const codec = __importStar(require("./cryptoStore"));
const modelManagement_1 = require("./modelManagement");
const modelActions_1 = require("./modelActions");
const proxy_1 = require("./proxy");
const modelDelegation_1 = require("./modelDelegation");
function equalSecret(actual, expected) {
    if (typeof actual !== 'string')
        return false;
    const bytes = Buffer.from(actual);
    const wanted = Buffer.from(expected);
    return bytes.length === wanted.length && (0, node_crypto_1.timingSafeEqual)(bytes, wanted);
}
function equalToken(actual, expected) {
    return equalSecret(actual, `Bearer ${expected}`);
}
/** Parsed JSON body, or undefined when it is missing, malformed or larger than the limit. */
async function readSmallJson(req, limit) {
    let length = 0;
    const chunks = [];
    try {
        for await (const chunk of req) {
            length += chunk.length;
            if (length > limit)
                return undefined;
            chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return undefined;
    }
}
const HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antigravity Model Manager</title><link rel="stylesheet" href="/_addon/style.css">
<body><main data-testid="settings-view"><h1>Antigravity Model Manager</h1><p>Models, providers and diagnostics for your local IDE proxy.</p>
<p id="connection-status" role="status"></p><section id="settings"><h2>Models &amp; Usage</h2></section></main>
<script src="/_addon/app.js"></script></body></html>`;
const STYLE = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111318;color:#e7e9ed}body{margin:0}main{max-width:1100px;margin:3rem auto;padding:0 1.5rem}button,input,select,textarea{font:inherit}button{cursor:pointer}h1{font-size:1.8rem}p{color:#b7bfcc}a{color:#91bcff}`;
const BRIDGE = `const key='antigravity-addon-token';
const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('token')||fragment.has('code'))history.replaceState(null,'',location.pathname);
if(fragment.has('token'))sessionStorage.setItem(key,fragment.get('token'));
const ready=fragment.has('code')?fetch('/_addon/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:fragment.get('code')})}).then(async response=>{if(response.ok)sessionStorage.setItem(key,(await response.json()).token);}).catch(()=>{}):Promise.resolve();
const bridge={invoke:async(channel,...args)=>{
 await ready;
 const response=await fetch('/_addon/rpc',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(sessionStorage.getItem(key)||'')},body:JSON.stringify({channel,args})});
 const value=await response.json();if(!response.ok)throw new Error(value.error||'Management request failed');return value;
}};
ready.then(()=>{if(!sessionStorage.getItem(key))document.getElementById('connection-status').textContent='Run npm run proxy:start -- --open again to connect.';});
`;
async function startStandaloneService(options) {
    if (!/^[a-f0-9]{64}$/.test(options.token) || !/^[a-f0-9-]{36}$/.test(options.instance))
        throw new Error('Invalid service identity');
    codec.configureCredentialDirectory(options.dataDirectory);
    const manager = (0, modelManagement_1.createModelManager)(options.dataDirectory, codec, browserLauncher_1.openBrowser);
    const stop = async () => {
        manager.googleLoginCancel();
        await (0, proxy_1.stopProxy)();
    };
    const actions = (0, modelActions_1.createModelActions)(manager);
    const handleDelegation = (0, modelDelegation_1.createModelDelegation)(proxy_1.loadCustomModels);
    // "proxy:start -- --open" puts this on the browser command line instead of the token.
    let handoff;
    const augmentations = ['customPreload.js', 'contextUsagePreload.js'].map((name) => {
        const preload = fs.readFileSync(path.join(__dirname, name), 'utf8');
        return `(function(exports,require){\n${preload}\n})({},name=>{if(name==='electron')return {ipcRenderer:bridge};throw new Error('Unsupported module');});`;
    });
    const appScript = `${BRIDGE}\n${augmentations.join('\n')}`;
    const respond = (res, status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
    };
    const handleManagement = (req, res) => {
        // startProxy guards every route (including generation) before this handler.
        if (!(req.url || '').startsWith('/_addon'))
            return false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        const assets = {
            '/_addon/': ['text/html; charset=utf-8', HTML],
            '/_addon/style.css': ['text/css; charset=utf-8', STYLE],
            '/_addon/app.js': ['application/javascript; charset=utf-8', appScript],
        };
        if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(assets, req.url)) {
            const [type, data] = assets[req.url];
            res.writeHead(200, { 'Content-Type': type });
            res.end(data);
            return true;
        }
        if (req.method === 'POST' && req.url === '/_addon/redeem') {
            void readSmallJson(req, 1024).then((body) => {
                const pending = handoff;
                const supplied = body?.code;
                if (pending && Date.now() < pending.expires && equalSecret(supplied, pending.code)) {
                    handoff = undefined;
                    respond(res, 200, { token: options.token });
                }
                else
                    respond(res, 401, { error: 'This sign-in code is not valid. Run proxy:start -- --open again.' });
            });
            return true;
        }
        if (!equalToken(req.headers.authorization, options.token)) {
            respond(res, 401, { error: 'Open the authenticated management URL from proxy:start' });
            return true;
        }
        if (req.method === 'POST' && req.url === '/_addon/handoff') {
            handoff = { code: (0, node_crypto_1.randomBytes)(32).toString('hex'), expires: Date.now() + 60000 };
            respond(res, 200, { code: handoff.code });
            return true;
        }
        if (handleDelegation(req, res))
            return true;
        if (req.method === 'GET' && req.url === '/_addon/health') {
            respond(res, 200, {
                service: 'antigravity-model-proxy',
                instance: options.instance,
                pid: process.pid,
                port: options.port,
            });
            return true;
        }
        if (req.method === 'POST' && req.url === '/_addon/stop') {
            respond(res, 200, { success: true });
            setImmediate(() => {
                void stop().then(() => options.onStop?.());
            });
            return true;
        }
        if (req.method !== 'POST' || req.url !== '/_addon/rpc') {
            respond(res, 404, { error: 'Unknown management route' });
            return true;
        }
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
            respond(res, 415, { error: 'Expected application/json' });
            return true;
        }
        void (async () => {
            let length = 0;
            const chunks = [];
            for await (const chunk of req) {
                length += chunk.length;
                if (length > 1024 * 1024) {
                    respond(res, 413, { error: 'Management request exceeds 1 MB' });
                    return;
                }
                chunks.push(Buffer.from(chunk));
            }
            let payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                respond(res, 400, { error: 'Invalid JSON' });
                return;
            }
            if (!payload ||
                typeof payload.channel !== 'string' ||
                !Object.prototype.hasOwnProperty.call(actions, payload.channel) ||
                !Array.isArray(payload.args) ||
                payload.args.length > 10) {
                respond(res, 400, { error: 'Unknown management action or invalid arguments' });
                return;
            }
            try {
                respond(res, 200, await actions[payload.channel](...payload.args));
            }
            catch (error) {
                respond(res, 200, { success: false, error: error.message });
            }
        })().catch(() => {
            if (!res.writableEnded && !res.destroyed)
                respond(res, 400, { error: 'Management request interrupted' });
        });
        return true;
    };
    const port = await (0, proxy_1.startProxy)({
        allowLanguageServerRouting: false,
        port: options.port,
        dataDirectory: options.dataDirectory,
        handleManagement,
        shutdownGraceMs: 1500,
        ideCloudCodeRouting: true,
    });
    return { port, stop };
}
//# sourceMappingURL=standaloneService.js.map