/** Owned loopback service for the IDE adapter and browser model manager. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openBrowser } from './browserLauncher';
import * as codec from './cryptoStore';
import { createModelManager } from './modelManagement';
import { createModelActions } from './modelActions';
import { startProxy, stopProxy, loadCustomModels } from './proxy';
import { createModelDelegation } from './modelDelegation';

export interface ServiceOptions {
  port: number;
  dataDirectory: string;
  token: string;
  instance: string;
  onStop?: () => void;
}

function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const bytes = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  return bytes.length === wanted.length && timingSafeEqual(bytes, wanted);
}
function equalToken(actual: unknown, expected: string): boolean {
  return equalSecret(actual, `Bearer ${expected}`);
}

/** Parsed JSON body, or undefined when it is missing, malformed or larger than the limit. */
async function readSmallJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) return undefined;
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
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

export async function startStandaloneService(
  options: ServiceOptions,
): Promise<{ port: number; stop: () => Promise<void> }> {
  if (!/^[a-f0-9]{64}$/.test(options.token) || !/^[a-f0-9-]{36}$/.test(options.instance))
    throw new Error('Invalid service identity');
  codec.configureCredentialDirectory(options.dataDirectory);
  const manager = createModelManager(options.dataDirectory, codec, openBrowser);
  const stop = async () => {
    manager.googleLoginCancel();
    await stopProxy();
  };
  const actions = createModelActions(manager);
  const handleDelegation = createModelDelegation(loadCustomModels);
  // "proxy:start -- --open" puts this on the browser command line instead of the token.
  let handoff: { code: string; expires: number } | undefined;
  const augmentations = ['customPreload.js', 'contextUsagePreload.js'].map((name) => {
    const preload = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return `(function(exports,require){\n${preload}\n})({},name=>{if(name==='electron')return {ipcRenderer:bridge};throw new Error('Unsupported module');});`;
  });
  const appScript = `${BRIDGE}\n${augmentations.join('\n')}`;
  const respond = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const handleManagement = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    // startProxy guards every route (including generation) before this handler.
    if (!(req.url || '').startsWith('/_addon')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const assets: Record<string, [string, string]> = {
      '/_addon/': ['text/html; charset=utf-8', HTML],
      '/_addon/style.css': ['text/css; charset=utf-8', STYLE],
      '/_addon/app.js': ['application/javascript; charset=utf-8', appScript],
    };
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(assets, req.url!)) {
      const [type, data] = assets[req.url!];
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
      return true;
    }
    if (req.method === 'POST' && req.url === '/_addon/redeem') {
      void readSmallJson(req, 1024).then((body) => {
        const pending = handoff;
        const supplied = (body as { code?: unknown } | undefined)?.code;
        if (pending && Date.now() < pending.expires && equalSecret(supplied, pending.code)) {
          handoff = undefined;
          respond(res, 200, { token: options.token });
        } else respond(res, 401, { error: 'This sign-in code is not valid. Run proxy:start -- --open again.' });
      });
      return true;
    }
    if (!equalToken(req.headers.authorization, options.token)) {
      respond(res, 401, { error: 'Open the authenticated management URL from proxy:start' });
      return true;
    }
    if (req.method === 'POST' && req.url === '/_addon/handoff') {
      handoff = { code: randomBytes(32).toString('hex'), expires: Date.now() + 60_000 };
      respond(res, 200, { code: handoff.code });
      return true;
    }
    if (handleDelegation(req, res)) return true;
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
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) {
          respond(res, 413, { error: 'Management request exceeds 1 MB' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let payload: { channel: string; args: unknown[] };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        respond(res, 400, { error: 'Invalid JSON' });
        return;
      }
      if (
        !payload ||
        typeof payload.channel !== 'string' ||
        !Object.prototype.hasOwnProperty.call(actions, payload.channel) ||
        !Array.isArray(payload.args) ||
        payload.args.length > 10
      ) {
        respond(res, 400, { error: 'Unknown management action or invalid arguments' });
        return;
      }
      try {
        respond(res, 200, await actions[payload.channel](...payload.args));
      } catch (error) {
        respond(res, 200, { success: false, error: (error as Error).message });
      }
    })().catch(() => {
      if (!res.writableEnded && !res.destroyed) respond(res, 400, { error: 'Management request interrupted' });
    });
    return true;
  };
  const port = await startProxy({
    allowLanguageServerRouting: false,
    port: options.port,
    dataDirectory: options.dataDirectory,
    handleManagement,
    shutdownGraceMs: 1500,
    ideCloudCodeRouting: true,
  });
  return { port, stop };
}
