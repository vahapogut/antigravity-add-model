#!/usr/bin/env node
/** Read-only diagnostics. Repair uses the existing transactional installer explicitly. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preflight, REQUIRED_BUILD_FILES } from './deploy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Explain whether the native model picker can reach the local model catalogue. */
export function languageServerEndpointCheck(mode) {
  if (mode === 'dynamic') {
    return {
      name: 'native model picker',
      status: 'warning',
      message:
        'The recognized Windows language-server binary still targets the remote Cloud Code endpoint. Native model-list requests may bypass the local proxy. If custom models are missing from the native picker, close Antigravity and run `node scripts/deploy.mjs --patch-language-server`; this recognized endpoint patch requires local proxy port 50999.',
    };
  }
  if (mode === 'fixed') {
    return {
      name: 'native model picker',
      status: 'ok',
      message: 'The language-server endpoint is configured to use the local proxy on port 50999.',
    };
  }
  return null;
}
export async function diagnose(options = {}) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const dist = options.dist || path.join(root, 'dist');
  const missing = REQUIRED_BUILD_FILES.filter(name => !fs.existsSync(path.join(dist, name)));
  add('build', missing.length ? 'error' : 'ok', missing.length ? `Run npm run build; missing: ${missing.join(', ')}` : 'All required addon modules are present');
  const modelsFile = options.models || path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
  if (!fs.existsSync(modelsFile)) add('models', 'info', 'No custom model configuration yet');
  else {
    try {
      const { readModelConfig } = require(path.join(dist, 'modelStore.js'));
      const { validateCustomModel } = require(path.join(dist, 'schemaValidator.js'));
      const models = readModelConfig(modelsFile);
      const names = new Set(models.map(model => model.name));
      let invalid = 0;
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const validation = validateCustomModel(model);
        if (!validation.valid) { invalid++; add(`model ${i + 1}`, 'error', validation.error); }
        const absent = (model.fallbackModels || []).filter(name => !names.has(name));
        if (absent.length) add(`model ${i + 1} fallback`, 'warning', `${absent.length} fallback model(s) no longer exist`);
      }
      if (names.size !== models.length) add('duplicates', 'error', 'Duplicate saved model names');
      add('models', invalid ? 'error' : 'ok', `${models.length} models, ${models.filter(model => model.enabled !== false).length} enabled, ${invalid} invalid`);
    } catch { add('models', 'error', 'Cannot parse/validate the model configuration. Preserve the file and check its JSON syntax.'); }
  }
  for (const [service, endpoint] of [['proxy', options.proxyUrl || 'http://127.0.0.1:50999'], ['gateway', options.gatewayUrl || 'http://127.0.0.1:51000']]) {
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid service URL');
      url.pathname = '/health'; url.search = ''; url.hash = '';
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const value = await response.json();
      if (!response.ok || !value || typeof value !== 'object') throw new Error('Unhealthy response');
      add(service, 'ok', 'Health endpoint responded');
    } catch { add(service, 'info', 'Not reachable. Start this optional service if you intend to use it.'); }
  }
  if (options.resources) {
    try {
      const info = preflight({ resources: options.resources, dist });
      add('installation', 'ok', `Runtime recognized (${info.version || 'version detected'}); patch preflight passed without changes`);
      const endpointCheck = languageServerEndpointCheck(info.plan?.mode);
      if (endpointCheck) checks.push(endpointCheck);
    } catch (error) { add('installation', 'error', error.message); }
  }
  return { healthy: !checks.some(check => check.status === 'error'), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  const names = { '--resources': 'resources', '--models': 'models', '--proxy-url': 'proxyUrl', '--gateway-url': 'gatewayUrl' };
  let jsonOutput = false;
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--json') jsonOutput = true;
      else if (names[arg] && process.argv[i + 1]) options[names[arg]] = process.argv[++i];
      else throw new Error('Usage: npm run doctor -- [--json] [--resources PATH] [--models FILE] [--proxy-url URL] [--gateway-url URL]');
    }
    const report = await diagnose(options);
    console.log(jsonOutput ? JSON.stringify(report, null, 2) : report.checks.map(check => `[${check.status.toUpperCase()}] ${check.name}: ${check.message}`).join('\n'));
    process.exitCode = report.healthy ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
