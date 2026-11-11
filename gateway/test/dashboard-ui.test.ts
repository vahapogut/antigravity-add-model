import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { BUILTIN_PROVIDERS } from '../src/provider-catalog.js';

const html = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
function definition(name: string, next: string): string {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

function fixture() {
  const dom = new JSDOM('<body><input id="customModelAlias"><div id="customModelProvider"><div class="psel-wrap"><select><option value="openrouter">OpenRouter</option></select></div></div><div id="customModelResolved"></div><div id="existingModel"></div></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const updates: unknown[][] = [];
  w.PROVIDER_META = { openrouter: { label: 'OpenRouter' } };
  w.logoHtml = () => '';
  w.esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w._fetchedModels = {};
  w._toggledModels = {};
  w._modelConfig = { _provider_models: {} };
  w.setModelName = (...args: unknown[]) => updates.push(args);
  w.renderCustomModelMappings = w.renderModelCards = w.toast = () => {};
  w.eval(definition('attachModelField', 'createModelNameFieldHtml'));
  w.eval(definition('addCustomModelMapping', 'removeCustomModelMapping'));
  return { dom, w, updates };
}

test('custom mapping accepts an arbitrary model without discovery and adds only the requested alias', () => {
  const { dom, w, updates } = fixture();
  try {
    w.attachModelField('customModelResolved', 'custom_openrouter', 'openrouter', '');
    const search = w.document.querySelector('.rsel-menu input');
    search.value = 'fixture-model';
    search.dispatchEvent(new w.Event('input'));
    const manual = w.document.querySelector('.rsel-manual');
    assert.equal(manual.hidden, false);
    assert.equal(manual.textContent, 'Use model name: fixture-model');
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    assert.equal(w.document.querySelector('#customModelResolved .rsel-value').value, 'fixture-model');
    assert.equal(updates.length, 0, 'draft selection must not add a phantom custom_<provider> mapping');
    w.document.getElementById('customModelAlias').value = 'browser-demo';
    w.addCustomModelMapping();
    assert.equal(JSON.stringify(w._modelConfig._provider_models), JSON.stringify({ 'browser-demo': { openrouter: 'fixture-model' } }));
  } finally { dom.window.close(); }
});

test('model picker uses fetched rows when the selected-model list is empty and supports explicit manual selection', () => {
  const { dom, w, updates } = fixture();
  try {
    w._fetchedModels.openrouter = ['discovered-model'];
    w._toggledModels.openrouter = [];
    w.attachModelField('existingModel', 'demo', 'openrouter', '');
    w.document.querySelector('.rsel-item').click();
    assert.deepEqual(updates[0], ['demo', 'openrouter', 'discovered-model']);
    const search = w.document.querySelector('.rsel-menu input');
    const name = 'manual/<model>"quoted';
    search.value = name;
    search.dispatchEvent(new w.Event('input'));
    w.document.querySelector('.rsel-manual').click();
    assert.deepEqual(updates[1], ['demo', 'openrouter', name]);
    assert.equal(w.document.querySelector('.rsel-text').textContent, name);
    assert.equal(w.document.querySelector('.rsel-text model'), null);
  } finally { dom.window.close(); }
});

test('login redirect stays on the dashboard origin and tolerates malformed next URLs', () => {
  const login = fs.readFileSync(new URL('../dashboard/login.html', import.meta.url), 'utf8');
  const start = login.indexOf('const params =');
  const end = login.indexOf('const stored =', start);
  for (const [next, expected] of [
    ['javascript:alert(1)', '/'], ['//outside.invalid/', '/'], ['http://[', '/'], ['/models?view=custom', '/models?view=custom'],
    // Dot segments are removed while parsing, which can leave a path that itself starts with two slashes.
    ['/.//outside.invalid/', '/'], ['/%2e//outside.invalid/x', '/'], ['/a/..//outside.invalid', '/'],
  ]) {
    const dom = new JSDOM('', { url: 'http://localhost/login.html?next=' + encodeURIComponent(next), runScripts: 'outside-only' });
    try {
      dom.window.eval(login.slice(start, end) + '\nwindow.redirectResult = nextUrl;');
      assert.equal((dom.window as any).redirectResult, expected);
    } finally { dom.window.close(); }
  }
});

test('history Replay handles colon IDs and sends only the stored request ID and selected alias', async () => {
  const id = 'fixture-uuid:out';
  const dom = new JSDOM(`<body><button id="replay-${id}">Replay</button><select id="rmodel-${id}"><option value="demo">demo</option></select><span id="rr-${id}" style="display:none"></span></body>`, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const calls: any[] = [];
  w.api = async (...args: any[]) => { calls.push(args); return { ok: true, text: 'Replayed the complete stored request' }; };
  w.toast = () => {};
  w.eval('async ' + definition('replayRequest', 'renderFailoverTimeline'));
  try {
    await w.replayRequest(id);
    assert.equal(JSON.stringify(calls), JSON.stringify([['POST', '/api/replay', { requestId: id, model: 'demo' }]]));
    assert.equal(w.document.getElementById('rr-' + id).textContent, 'Replayed the complete stored request');
    assert.equal(w.document.getElementById('replay-' + id).disabled, false);
  } finally { dom.window.close(); }
});

function providerFixture() {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  w.eval(script.slice(0, script.indexOf('// ---- Init ----')));
  const providers = [...BUILTIN_PROVIDERS, {
    id: 'future-cloud', name: 'Future Cloud', envKey: 'FUTURE_API_KEY',
    baseUrlEnv: 'FUTURE_BASE_URL', baseUrl: 'https://future.invalid/v1',
  }];
  const calls: any[][] = [];
  w.api = async (...args: any[]) => {
    calls.push(args);
    if (args[1] === '/api/providers') return { providers };
    if (args[1] === '/api/provider-models') {
      if (args[0] === 'GET') return { providers: [] };
      return { models: ['discovered/' + args[2].provider], fetchedAt: 1 };
    }
    return { ok: true };
  };
  const reloadStatus = w.reloadAll;
  w.reloadAll = w.toast = () => {};
  return { dom, w, calls, providers, reloadStatus };
}

test('registry metadata supplies settings, routing and model selectors including future providers', async () => {
  const { dom, w, providers } = providerFixture();
  try {
    await w.loadProviderMetadata();
    const expected = providers.map(provider => provider.id);
    assert.equal(w.document.querySelectorAll('.provider-config-card').length, expected.length);
    const selector = w.createProviderSelect('huggingface', () => {});
    assert.deepEqual(Array.from(selector.querySelectorAll('option'), (option: any) => option.value), expected);
    assert.equal(selector.querySelector('select').value, 'huggingface');
    w.attachProviderField('customModelProvider', 'demo', 'future-cloud', () => {});
    assert.equal(w.document.querySelector('#customModelProvider select').value, 'future-cloud');
    assert.equal(w.document.querySelectorAll('#customModelProvider option').length, expected.length);

    const status = [{ id: 'together', hasKey: true }, { id: 'huggingface', hasKey: false }];
    w.renderProviderPriority(['together'], status);
    w.showAddProviderModal(['together'], status);
    w.document.querySelector('.provider-picker [data-provider="huggingface"]').click();
    assert.equal(w.getProviderPriority(), 'together,huggingface');
    const drop = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'together' } });
    w.document.querySelector('.prio-item[data-provider="huggingface"]').dispatchEvent(drop);
    assert.equal(w.getProviderPriority(), 'huggingface,together');
    assert.match(w.document.querySelector('.prio-item[data-provider="together"]').textContent, /✓/);
    assert.match(w.document.querySelector('.prio-item[data-provider="huggingface"]').textContent, /○/);

    w.renderPricingEditor({});
    assert.ok(w.document.getElementById('pe-future-cloud'));
    assert.ok(w.collectPricingFromEditor()['future-cloud']);
    assert.ok(w.document.querySelector('img[src="/antigravity-logo.png"], img[src="antigravity-logo.png"]'), 'official dashboard logo stays intact');
  } finally { dom.window.close(); }
});

test('provider settings save canonical keys and endpoint overrides without replaying masked credentials', async () => {
  const { dom, w, calls, providers } = providerFixture();
  try {
    await w.loadProviderMetadata();
    w.updateProviderSettings({ providers: [{ id: 'huggingface', hasKey: true }], env: { HUGGINGFACE_API_KEY: 'secr••••tail', TOGETHER_BASE_URL: 'https://old.invalid/v1' } });
    const hf = w.document.getElementById('provider-key-huggingface');
    assert.equal(hf.type, 'password');
    assert.equal(hf.value, '');
    assert.match(hf.placeholder, /Configured/);
    assert.ok(!w.document.getElementById('providerConfigFields').innerHTML.includes('secr••••tail'));
    for (const provider of providers.filter(provider => provider.envKey && provider.id !== 'huggingface')) {
      w.document.getElementById('provider-key-' + provider.id).value = 'fixture-key-' + provider.id;
    }
    const url = w.document.getElementById('provider-url-together');
    url.value = '';
    url.dispatchEvent(new w.Event('input'));
    const customUrl = w.document.getElementById('provider-url-dashscope');
    customUrl.value = 'https://regional.invalid/compatible-mode/v1';
    customUrl.dispatchEvent(new w.Event('input'));
    // A periodic status update must not discard a user's unsaved endpoint edit.
    w.updateProviderSettings({ env: { DASHSCOPE_BASE_URL: 'https://old.invalid/v1' } });
    assert.equal(customUrl.value, 'https://regional.invalid/compatible-mode/v1');
    await w.saveConfig();
    const saved = calls.find(call => call[0] === 'POST' && call[1] === '/api/config')![2];
    assert.equal(saved.HUGGINGFACE_API_KEY, undefined, 'blank key preserves a key or HF_TOKEN configured on the server');
    assert.equal(saved.TOGETHER_BASE_URL, '', 'empty endpoint explicitly resets the override');
    assert.equal(saved.DASHSCOPE_BASE_URL, 'https://regional.invalid/compatible-mode/v1');
    for (const provider of providers.filter(provider => provider.envKey && provider.id !== 'huggingface')) {
      assert.equal(saved[provider.envKey], 'fixture-key-' + provider.id);
      assert.equal(w.document.getElementById('provider-key-' + provider.id).value, '', 'saved credential is cleared from the form');
    }
  } finally { dom.window.close(); }
});

test('Browse discovers new-provider models and discards a temporary key when the provider changes', async () => {
  const { dom, w, calls } = providerFixture();
  try {
    await w.loadProviderMetadata();
    w.browseInit();
    w.selectBrowseProvider('siliconflow');
    w.document.getElementById('browseApiKey').value = 'temporary-siliconflow-key';
    await w.browseFetch(false);
    const request = calls.find(call => call[0] === 'POST' && call[1] === '/api/provider-models');
    assert.equal(JSON.stringify(request![2]), JSON.stringify({ provider: 'siliconflow', apiKey: 'temporary-siliconflow-key', force: false }));
    assert.match(w.document.getElementById('browseModelList').textContent, /discovered\/siliconflow/);
    w.attachModelField('customModelResolved', 'demo', 'siliconflow', '');
    assert.equal(w.document.querySelector('.rsel-item').dataset.model, 'discovered/siliconflow');
    w.selectBrowseProvider('novita');
    assert.equal(w.document.getElementById('browseApiKey').value, '');
    assert.equal(w.document.getElementById('browseResultsPanel').style.display, 'none');
    await w.browseFetch(false);
    const last = calls.filter(call => call[0] === 'POST' && call[1] === '/api/provider-models').at(-1);
    assert.equal(last![2].provider, 'novita');
    assert.equal(last![2].apiKey, undefined, 'uses that provider’s saved key instead of the previous temporary key');
  } finally { dom.window.close(); }
});

test('compaction effort loads independently and the settings form submits the selected override', async () => {
  const { dom, w, calls, reloadStatus } = providerFixture();
  try {
    w.reloadAll = reloadStatus;
    w.loadLocalProviders = w.updateAuthStatus = w.updateProviderSettings = () => {};
    let effort: string | undefined = 'low';
    w.api = async (...args: any[]) => {
      calls.push(args);
      if (args[1] === '/api/status') return {
        stats: { totalRequests: 0, totalTokens: 0, totalToolCalls: 0, errors: 0 },
        env: {}, providerPriority: [], providers: [], compactionReasoningEffort: effort,
      };
      return { ok: true };
    };
    await w.reloadAll();
    const select = w.document.getElementById('cfgCompactionEffort');
    assert.equal(select.value, 'low');
    assert.deepEqual(Array.from(select.options, (option: any) => option.value), ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    select.value = 'none';
    await w.saveConfig();
    const saved = calls.find(call => call[0] === 'POST' && call[1] === '/api/config')![2];
    assert.equal(saved.COMPACTION_REASONING_EFFORT, 'none');
    assert.equal(calls.some(call => call[1] === '/api/reasoning-effort'), false, 'normal model effort is not edited');
    effort = undefined;
    await w.reloadAll();
    assert.equal(select.value, 'inherit');
  } finally { dom.window.close(); }
});
