#!/usr/bin/env node
/** Exercise desktop import -> local proxy -> optional gateway -> mock provider. No live account. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import Module, { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateway-smoke-'));
const gatewayData = path.join(temporary, 'gateway');
const home = path.join(temporary, 'home');
const token = 'integration-fixture-token-not-a-real-secret';
let child;
let proxy;
let output = '';
let calls = 0;
const originalLoad = Module._load;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODULE_LOAD_ERRORS = /ERR_REQUIRE_ASYNC_MODULE|ERR_MODULE_NOT_FOUND/;

/** R2.2, R2.5: the compiled CommonJS proxy and the auto-patcher load with plain require(). */
function checkNormModulesLoad() {
  const targets = ['dist/proxy/customRequest.js', 'dist/proxy/modelUtils.js', 'dist/norm/ideAutoPatcher.mjs']
    .map(file => path.join(root, file));
  const script = `for (const file of ${JSON.stringify(targets)}) require(file);`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const text = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `require() of the built OmniNorm modules failed:\n${text}`);
  assert.doesNotMatch(text, MODULE_LOAD_ERRORS);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const exited = new Promise(resolve => processHandle.once('exit', resolve));
  processHandle.kill('SIGTERM'); // TerminateProcess on Windows, a graceful signal elsewhere.
  await Promise.race([exited, sleep(3000)]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill('SIGKILL');
    await Promise.race([exited, sleep(3000)]);
  }
}

/** R2.1: the built standalone service accepts TCP connections within 10 s without module loading errors. */
async function checkStandaloneServiceStarts() {
  const port = await freePort();
  const dataDirectory = path.join(temporary, 'service-data');
  const serviceHome = path.join(temporary, 'service-home');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(serviceHome, { recursive: true });
  let serviceOutput = '';
  const service = spawn(process.execPath, [path.join(root, 'scripts/desktop-service.mjs'), 'run', '--port', String(port), '--data-dir', dataDirectory], {
    cwd: root,
    env: { ...process.env, ANTIGRAVITY_IDE_AUTOPATCH: '0', HOME: serviceHome, USERPROFILE: serviceHome },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout.on('data', chunk => { serviceOutput += chunk; });
  service.stderr.on('data', chunk => { serviceOutput += chunk; });
  try {
    const deadline = Date.now() + 10000;
    let connected = false;
    while (!connected && Date.now() < deadline) {
      if (service.exitCode !== null) throw new Error(`Standalone service exited (${service.exitCode}) during startup:\n${serviceOutput}`);
      connected = await canConnect(port);
      if (!connected) await sleep(100);
    }
    assert.ok(connected, `Standalone service did not accept a TCP connection on 127.0.0.1:${port} within 10 s:\n${serviceOutput}`);
    assert.doesNotMatch(serviceOutput, MODULE_LOAD_ERRORS, serviceOutput);
  } finally {
    await stopChild(service);
  }
  assert.doesNotMatch(serviceOutput, MODULE_LOAD_ERRORS, serviceOutput);
}

const provider = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-provider-key');
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); return; }
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/chat/completions');
  const buffers = []; for await (const chunk of req) buffers.push(chunk);
  const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  assert.equal(body.model, 'mock-model');
  calls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Gateway integration works.' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});

try {
  checkNormModulesLoad();
  await checkStandaloneServiceStarts();
  console.log('PASS: built OmniNorm modules load with require() and the standalone service accepts TCP connections without module loading errors.');
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(gatewayData, { recursive: true });
  const settings = {
    PROVIDER_PRIORITY: 'openai', OPENAI_API_KEY: 'fixture-provider-key', OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
    PROXY_PORT: '0', API_PORT: '0', AG_GATEWAY_HOST: '127.0.0.1', AG_GATEWAY_REMOTE: 'false', AG_GATEWAY_TOKEN: token,
    DASHBOARD_USER: 'fixture', DASHBOARD_PASSWORD: 'fixture-dashboard-password', CONTEXT_STRIP_MODE: 'passthrough',
    COMPACTION_ENABLED: 'false', PROXY_RETRIES: '0', LOG_LEVEL: 'error', RATE_LIMIT_GLOBAL: '0', RATE_LIMIT_PROVIDER: '0',
  };
  fs.writeFileSync(path.join(gatewayData, '.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'));
  fs.writeFileSync(path.join(gatewayData, 'models.json'), JSON.stringify({ demo: 'mock-model', _provider_models: { demo: { openai: 'mock-model' } }, _global_provider_priority: ['openai'], _compaction_enabled: false }));
  child = spawn(process.execPath, [path.join(root, 'gateway/dist/cli.js'), 'start', '--foreground'], {
    cwd: root, env: { ...process.env, ...settings, AG_GATEWAY_DATA_DIR: gatewayData }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const runtimeFile = path.join(gatewayData, 'runtime.json');
  for (let i = 0; !fs.existsSync(runtimeFile) && i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Gateway stopped during startup: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(fs.existsSync(runtimeFile), `Gateway failed to start: ${output}`);
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const gatewayUrl = `http://127.0.0.1:${runtime.generationPort}`;
  assert.equal((await fetch(`${gatewayUrl}/models`)).status, 401);

  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const electron = { app: { getPath: () => home, getAppPath: () => temporary }, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } };
  Module._load = function(id, ...args) {
    if (id === 'electron') return electron;
    if (id === 'electron-log') return logger;
    return originalLoad.call(this, id, ...args);
  };
  const require = createRequire(import.meta.url);
  const { createModelManager } = require(path.join(root, 'dist/modelManagement.js'));
  const codec = require(path.join(root, 'dist/cryptoStore.js'));
  const manager = createModelManager(path.join(home, '.gemini', 'antigravity'), codec, async () => {});
  assert.equal((await manager.importGatewayModels({ url: gatewayUrl, token, dashboardUrl: `http://127.0.0.1:${runtime.dashboardPort}` })).count, 1);
  assert.equal(manager.store.list()[0].apiKey, '********');
  assert.equal((await manager.testModel(manager.store.list()[0])).success, true);
  proxy = require(path.join(root, 'dist/proxy.js'));
  const port = await proxy.startProxy();
  const body = { conversationId: 'smoke-conversation', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
  const generate = await fetch(`http://127.0.0.1:${port}/v1beta/models/gateway-demo:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  assert.equal(generate.status, 200, await generate.clone().text());
  assert.match((await generate.json()).candidates[0].content.parts[0].text, /Gateway integration works/);
  const stream = await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'models/gateway-demo', conversationId: 'smoke-conversation', request: body }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(stream.status, 200);
  const frames = (await stream.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(frames.some(frame => frame.response?.candidates?.[0]?.content?.parts?.some(part => /Gateway integration works/.test(part.text))));
  assert.equal(calls, 2);
  const history = new DatabaseSync(path.join(gatewayData, 'data', 'gateway.db'), { readOnly: true });
  try {
    assert.equal(history.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1, 'Two turns in one desktop conversation must remain one gateway session');
    assert.equal(history.prepare('SELECT COUNT(DISTINCT session_id) AS count FROM requests').get().count, 1);
  } finally { history.close(); }
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  console.log('PASS: authenticated import, masked credentials, model discovery, native JSON and Cloud Code SSE across desktop proxy -> gateway -> provider.');
} finally {
  await proxy?.stopProxy();
  Module._load = originalLoad;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
