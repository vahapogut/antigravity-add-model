import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const model = {
  name: 'models/primary',
  displayName: 'Primary',
  provider: 'openai',
  apiFormat: 'openai',
  apiUrl: 'https://provider.example/v1',
  apiKey: '********',
  externalModelName: 'model-a',
  customHeaders: { 'X-Workspace': '********' },
  enabled: true,
};
const presets = [
  { id: 'openai', label: 'OpenAI', defaultUrl: 'https://provider.example/v1', apiFormat: 'openai', keyRequired: true },
  { id: 'ollama', label: 'Ollama', defaultUrl: 'http://127.0.0.1:11434/v1', apiFormat: 'openai', keyRequired: false },
  {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    defaultUrl: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions',
    apiFormat: 'openai',
    keyRequired: true,
  },
  {
    id: 'google-cloudcode',
    label: 'Google Cloud Code accounts',
    defaultUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiFormat: 'google',
    keyRequired: false,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    defaultUrl: 'https://opencode.ai/inference/v1/chat/completions',
    apiFormat: 'openai',
    keyRequired: false,
  },
];
const openWindows: JSDOM[] = [];
afterEach(() => {
  for (const dom of openWindows.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  }
});
const settle = () => new Promise<void>((done) => setImmediate(done));

async function fixture(
  html = '<section id="settings"><h2>Models &amp; Usage</h2></section>',
  initialModels: Record<string, unknown>[] = [model],
  url = 'http://127.0.0.1:54321/settings',
) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom);
  await new Promise<void>((done) => dom.window.addEventListener('DOMContentLoaded', () => done(), { once: true }));
  let models = initialModels.map((value) => ({ ...value }));
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'storage:get-custom-models': () => models.map((entry) => ({ ...entry })),
    'storage:get-provider-presets': () => presets,
    'storage:save-custom-model': (entry) => {
      const index = models.findIndex(
        (value) => value.name === (entry.copyFrom ? entry.name : entry.originalName || entry.name),
      );
      if (index < 0) models.push({ ...entry });
      else models[index] = { ...entry };
      return { success: true };
    },
    'storage:delete-custom-model': (name) => {
      models = models.filter((entry) => entry.name !== name);
      return { success: true };
    },
    'storage:test-model-connection': () => ({
      success: true,
      message: 'Model listing verified. Generation was not tested.',
    }),
    'storage:test-model-generation': () => ({ success: true, message: 'Generation succeeded (HTTP 200, 12 ms).' }),
    'storage:create-effort-variants': () => ({ success: true, count: 3 }),
    'storage:get-diagnostics': () => ({
      success: true,
      active: 0,
      capacity: 200,
      summary: { requests: 1, succeeded: 1, failed: 0, cancelled: 0, measuredRequests: 0 },
      recentModels: ['models/primary'],
      requests: [
        {
          id: 'test',
          timestamp: Date.now(),
          model: '<script>bad()</script>',
          provider: 'openai',
          outcome: 'succeeded',
          status: 200,
          latencyMs: 12,
          stream: false,
          kind: 'request',
        },
      ],
    }),
    'storage:clear-diagnostics': () => ({ success: true }),
    'storage:discover-models': () => ({
      success: true,
      models: [
        { id: 'model-b', displayName: 'Second model' },
        { id: 'model-c', displayName: '<script>bad()</script>' },
      ],
    }),
    'storage:discover-local': () => ({
      success: true,
      servers: [{ provider: 'ollama', apiUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'local-model' }] }],
    }),
    'storage:export-custom-models': () => ({
      version: 1,
      models: [{ name: 'models/primary', provider: 'openai', apiUrl: model.apiUrl, externalModelName: 'model-a' }],
    }),
    'storage:import-custom-models': () => ({ success: true, count: 2 }),
    'storage:get-gateway': () => ({
      url: 'https://gateway.example',
      token: '********',
      dashboardUrl: 'https://dashboard.example',
    }),
    'storage:save-gateway': () => ({ success: true }),
    'storage:test-gateway': () => ({ success: true, message: 'Gateway authenticated; 2 aliases available' }),
    'storage:import-gateway-models': () => ({ success: true, count: 2 }),
    'storage:open-gateway-dashboard': () => ({ success: true }),
    'storage:google-login': (input) => ({
      success: true,
      account: {
        id: 'pending-account',
        label: 'New account',
        clientId: 'desktop.apps.googleusercontent.com',
        refreshToken: '********',
        accessToken: '********',
        expiresAt: 2000000000000,
        authMode: input.authMode,
        ...(input.authMode === 'antigravity'
          ? { project: 'prepared-project', cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com' }
          : {}),
      },
    }),
    'storage:google-login-cancel': () => ({ success: true }),
    'storage:google-test-account': () => ({ success: true, message: 'Quota checked', quota: { remaining: 75 } }),
    'storage:google-account-prepare': (input) => ({
      success: true,
      account: {
        ...(input.account ||
          (models.find((entry) => entry.name === input.modelName)?.googleAccounts as { id: string }[])?.find(
            (account) => account.id === input.accountId,
          )),
        project: 'prepared-project',
        cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
      },
    }),
    'storage:google-pool-status': () => ({ success: true, accounts: [{ id: 'saved-account', inFlight: 0 }] }),
  };
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (!handlers[channel]) throw new Error(`Unexpected IPC: ${channel}`);
    return handlers[channel](...args);
  });
  const vendorStorage = Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() });
  const context = dom.getInternalVMContext();
  Object.assign(context, {
    exports: {},
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Sandbox dependency: ${id}`);
      return { ipcRenderer: { invoke } };
    },
    Response,
    Request,
  });
  Object.assign(dom.window, {
    nativeStorage: vendorStorage,
    fetch: vi.fn(async () => new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } })),
    confirm: vi.fn(() => {
      throw new Error('Blocking native confirmation dialogs must not be used.');
    }),
  });
  runInContext(preload, context);
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settle();
  const document = dom.window.document;
  function input(id: string, value?: string): HTMLInputElement {
    const node = document.getElementById(id) as HTMLInputElement;
    expect(node, `Missing #${id}`).toBeTruthy();
    if (value !== undefined) node.value = value;
    return node;
  }
  async function click(label: string, within: Element | Document = document) {
    const node = Array.from(within.querySelectorAll<HTMLButtonElement>('button')).find(
      (value) => value.textContent === label,
    );
    expect(node, `Missing button ${label}`).toBeTruthy();
    node!.click();
    await settle();
  }
  return { dom, document, invoke, handlers, input, click, vendorStorage, getModels: () => models };
}

describe('custom model settings in the preserved vendor preload', () => {
  it.each(['Cancel', 'Escape', 'Close'])('cancels model deletion with %s without changing storage', async (action) => {
    const f = await fixture();
    const deleteButton = [...f.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === 'Delete',
    )!;
    deleteButton.focus();
    await f.click('Delete');
    const dialog = f.document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Delete “Primary”?');
    expect(f.invoke).not.toHaveBeenCalledWith('storage:delete-custom-model', model.name);
    if (action === 'Escape')
      dialog.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else await f.click(action, dialog);
    expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
    expect(f.document.activeElement).toBe(deleteButton);
    expect(deleteButton.disabled).toBe(false);
    expect(f.invoke).not.toHaveBeenCalledWith('storage:delete-custom-model', model.name);
    expect(f.getModels()).toHaveLength(1);
    expect(f.dom.window.confirm).not.toHaveBeenCalled();
  });

  it('deletes through an in-app dialog and keeps Add model and the native prompt focusable', async () => {
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2><button id="native-refresh">Refresh</button></section><textarea id="native-prompt"></textarea>',
    );
    const refresh = vi.fn(() => expect(f.document.getElementById('agy-modal-overlay')).toBeNull());
    f.document.getElementById('native-refresh')!.addEventListener('click', refresh);
    await f.click('Delete');
    await f.click('Delete model', f.document.querySelector('[role="dialog"]')!);
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'storage:delete-custom-model')).toEqual([
      ['storage:delete-custom-model', model.name],
    ]);
    expect(f.getModels()).toHaveLength(0);
    expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
    expect(f.document.activeElement).toBe(f.document.getElementById('agy-add-model'));
    expect(refresh).toHaveBeenCalledOnce();
    await f.click('Add model');
    const provider = f.input('agy-provider', 'ollama');
    provider.focus();
    provider.dispatchEvent(new f.dom.window.Event('change'));
    expect(f.document.activeElement).toBe(provider);
    const modelId = f.input('agy-model-id', 'replacement-model');
    modelId.focus();
    expect(f.document.activeElement).toBe(modelId);
    expect(modelId.disabled).toBe(false);
    expect(f.input('agy-api-url').value).toBe('http://127.0.0.1:11434/v1');
    await f.click('Close', f.document.querySelector('[role="dialog"]')!);
    const prompt = f.document.getElementById('native-prompt') as HTMLTextAreaElement;
    prompt.focus();
    prompt.value = 'The prompt is still available';
    expect(f.document.activeElement).toBe(prompt);
    expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
    expect(f.dom.window.confirm).not.toHaveBeenCalled();
  });

  it('keeps a failed deletion visible and allows a retry', async () => {
    const f = await fixture();
    const remove = f.handlers['storage:delete-custom-model'];
    f.handlers['storage:delete-custom-model'] = () => ({ success: false, error: 'Could not write model settings.' });
    await f.click('Delete');
    const dialog = f.document.querySelector('[role="dialog"]')!;
    await f.click('Delete model', dialog);
    expect(dialog.querySelector('[role="status"]')!.textContent).toBe('Could not write model settings.');
    expect(f.getModels()).toHaveLength(1);
    expect([...dialog.querySelectorAll('button')].every((node) => !node.disabled)).toBe(true);
    f.handlers['storage:delete-custom-model'] = remove;
    await f.click('Delete model', dialog);
    expect(f.getModels()).toHaveLength(0);
    expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
  });

  it('does not close a new dialog when a previously confirmed deletion finishes', async () => {
    const f = await fixture();
    const remove = f.handlers['storage:delete-custom-model'];
    let finish!: () => void;
    f.handlers['storage:delete-custom-model'] = (name) => new Promise((resolve) => {
      finish = () => resolve(remove(name));
    });
    await f.click('Delete');
    await f.click('Delete model', f.document.querySelector('[role="dialog"]')!);
    await f.click('Close', f.document.querySelector('[role="dialog"]')!);
    await f.click('Add model');
    const input = f.input('agy-model-id', 'new-model');
    input.focus();
    finish();
    await settle();
    expect(f.getModels()).toHaveLength(0);
    expect(f.document.getElementById('agy-modal-title')!.textContent).toBe('Add custom model');
    expect(f.document.activeElement).toBe(input);
    expect(input.value).toBe('new-model');
    await f.click('Close', f.document.querySelector('[role="dialog"]')!);
    expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
  });

  it('explains when a model has no available native picker identity', async () => {
    const f = await fixture(undefined, [{ ...model, nativePickerAvailable: false }]);
    expect(f.document.getElementById('agy-custom-models-content')!.textContent).toContain(
      'Not currently available in the native model picker',
    );
    expect(f.document.getElementById('agy-custom-models-content')!.textContent).toContain(
      'Direct API access remains available',
    );
  });

  it('shows diagnostics with unknown usage and escapes model names in filtered history and export', async () => {
    const f = await fixture();
    await f.click('Diagnostics');
    expect(f.document.getElementById('agy-diagnostics-summary')!.textContent).toContain('Token usage: unknown');
    expect(f.document.getElementById('agy-diagnostics-requests')!.textContent).toContain('<script>bad()</script>');
    expect(f.document.querySelector('#agy-modal-overlay script')).toBeNull();
    const search = f.input('agy-diagnostics-search', 'missing');
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.getElementById('agy-diagnostics-requests')!.textContent).toContain('No matching requests');
    await f.click('Export diagnostics');
    expect((f.document.getElementById('agy-diagnostics-export') as HTMLTextAreaElement).value).toContain(
      '"capacity": 200',
    );
    await f.click('Clear diagnostic history');
    expect(f.invoke).toHaveBeenCalledWith('storage:clear-diagnostics');
  });

  it('runs generation only after the user chooses the charge-labelled test flow', async () => {
    const f = await fixture();
    await f.click('Test generation');
    expect(f.document.getElementById('agy-modal-card')!.textContent).toContain('may charge');
    expect(f.invoke).not.toHaveBeenCalledWith('storage:test-model-generation', expect.anything());
    await f.click('Run generation test');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:test-model-generation',
      expect.objectContaining({ name: model.name, apiKey: '********' }),
    );
    expect(f.document.getElementById('agy-modal-card')!.textContent).toContain('Generation succeeded');
  });

  it('creates reasoning variants only after showing their budgets', async () => {
    const f = await fixture();
    await f.click('Effort variants');
    expect(f.document.getElementById('agy-modal-card')!.textContent).toContain('8,192');
    expect(f.invoke).not.toHaveBeenCalledWith('storage:create-effort-variants', model.name);
    await f.click('Create three variants');
    expect(f.invoke).toHaveBeenCalledWith('storage:create-effort-variants', model.name);
  });

  it('saves and clears compaction effort independently of normal reasoning settings', async () => {
    const f = await fixture(undefined, [{ ...model, reasoningEffort: 'xhigh', thinkingBudget: 8192 }]);
    await f.click('Edit');
    expect(f.input('agy-compaction-effort').value).toBe('');
    f.input('agy-compaction-effort', 'low');
    await f.click('Save model');
    expect(f.getModels()[0]).toMatchObject({
      reasoningEffort: 'xhigh',
      thinkingBudget: 8192,
      compactionReasoningEffort: 'low',
    });
    await f.click('Edit');
    expect(f.input('agy-compaction-effort').value).toBe('low');
    expect(f.input('agy-reasoning-effort').value).toBe('xhigh');
    expect(f.input('agy-thinking-budget').value).toBe('8192');
    f.input('agy-compaction-effort', 'none');
    await f.click('Save model');
    expect(f.getModels()[0]).toMatchObject({
      reasoningEffort: 'xhigh',
      thinkingBudget: 8192,
      compactionReasoningEffort: 'none',
    });
    await f.click('Edit');
    expect(f.input('agy-compaction-effort').value).toBe('none');
    f.input('agy-compaction-effort', '');
    await f.click('Save model');
    expect(f.getModels()[0]).toMatchObject({ reasoningEffort: 'xhigh', thinkingBudget: 8192 });
    expect(f.getModels()[0].compactionReasoningEffort).toBeUndefined();
    await f.click('Edit');
    expect(f.input('agy-compaction-effort').value).toBe('');
    expect(f.input('agy-reasoning-effort').value).toBe('xhigh');
    expect(f.input('agy-thinking-budget').value).toBe('8192');
  });

  it('round-trips the optional native compaction threshold without changing model limits or effort', async () => {
    const f = await fixture(undefined, [{
      ...model, contextWindow: 85000, maxOutputTokens: 8192,
      reasoningEffort: 'xhigh', compactionReasoningEffort: 'low',
    }]);
    await f.click('Edit');
    expect(f.input('agy-compaction-threshold').value).toBe('');
    expect(f.input('agy-compaction-threshold').min).toBe('10');
    expect(f.input('agy-compaction-threshold').max).toBe('90');
    f.input('agy-compaction-threshold', '80');
    await f.click('Save model');
    expect(f.getModels()[0]).toMatchObject({
      compactionThresholdPercent: 80, contextWindow: 85000, maxOutputTokens: 8192,
      reasoningEffort: 'xhigh', compactionReasoningEffort: 'low',
    });
    await f.click('Edit');
    expect(f.input('agy-compaction-threshold').value).toBe('80');
    f.input('agy-compaction-threshold', '');
    await f.click('Save model');
    expect(f.getModels()[0].compactionThresholdPercent).toBeUndefined();
    expect(f.getModels()[0]).toMatchObject({ contextWindow: 85000, maxOutputTokens: 8192, compactionReasoningEffort: 'low' });
  });

  it.each(['9', '91', '50.5'])('rejects out-of-range or fractional native compaction thresholds: %s', async (value) => {
    const f = await fixture(undefined, [{ ...model, contextWindow: 85000, maxOutputTokens: 8192 }]);
    await f.click('Edit');
    f.input('agy-compaction-threshold', value);
    await f.click('Save model');
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'storage:save-custom-model')).toHaveLength(0);
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toMatch(/IDE compaction threshold (?:must|cannot)/);
  });

  it('requires the real context window before saving a native threshold', async () => {
    const f = await fixture();
    await f.click('Edit');
    f.input('agy-compaction-threshold', '80');
    await f.click('Save model');
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'storage:save-custom-model')).toHaveLength(0);
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Set the actual context window');
  });

  it('offers adaptive account selection without changing an existing strategy', async () => {
    const f = await fixture(undefined, [
      { ...model, provider: 'google-cloudcode', googlePool: { strategy: 'quota' }, googleAccounts: [] },
    ]);
    await f.click('Edit');
    const strategy = f.document.getElementById('agy-google-pool-strategy') as HTMLSelectElement;
    expect(strategy.value).toBe('quota');
    expect(Array.from(strategy.options).map((option) => option.value)).toContain('adaptive');
  });

  it('mounts under a div-based Models & Usage heading without a text Refresh button', async () => {
    const f = await fixture(
      '<nav><button><span>Models &amp; Usage</span></button></nav><main class="overflow-y-auto"><div id="settings"><div><span>Models &amp; Usage</span><button aria-label="Refresh quota"></button></div></div></main>',
    );
    expect(f.document.querySelector('#settings > #agy-custom-models-section')).toBeTruthy();
    expect(f.document.querySelector('nav #agy-custom-models-section')).toBeNull();
    expect((f.dom.window as unknown as { nativeStorage: unknown }).nativeStorage).toBe(f.vendorStorage);
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
  });

  it('reinjects after the settings pane is replaced at the same URL and ignores unrelated panes', async () => {
    const f = await fixture(
      '<section id="settings"><h2>MCP Servers</h2><div><div><button>Refresh</button></div></div></section>',
    );
    f.document.getElementById('settings')!.remove();
    f.document.body.innerHTML = '<nav><button>Models &amp; Usage</button></nav><section><h2>Appearance</h2></section>';
    await new Promise((done) => setTimeout(done, 200));
    expect(f.document.querySelector('#agy-custom-models-section')).toBeNull();
    f.document.body.innerHTML = '<section id="new-settings"><h2>Models &amp; Usage</h2></section>';
    await vi.waitFor(() => expect(f.document.querySelector('#new-settings #agy-custom-models-section')).toBeTruthy());
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
    expect(f.document.querySelectorAll('#agy-manager-style')).toHaveLength(1);
  });

  it('guides Cloudflare account setup and blocks test, discovery, and save until the URL is complete', async () => {
    const f = await fixture();
    await f.click('Add model');
    f.input('agy-provider', 'workers-ai').dispatchEvent(new f.dom.window.Event('change'));
    expect(f.input('agy-api-url').value).toContain('/accounts/ACCOUNT_ID/');
    const hint = [...f.document.querySelectorAll('p')].find((node) => node.textContent?.startsWith('Cloudflare:'))!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Workers AI API token template');
    f.input('agy-api-key', 'private-token');
    f.input('agy-model-id', '@cf/text-model');
    await f.click('Test connection');
    await f.click('Fetch provider models');
    await f.click('Save model');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('32-character Account ID');
    expect(
      f.invoke.mock.calls.some(([channel]) =>
        ['storage:test-model-connection', 'storage:discover-models', 'storage:save-custom-model'].includes(channel),
      ),
    ).toBe(false);
    f.input(
      'agy-api-url',
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions',
    );
    await f.click('Test connection');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Generation was not tested');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        provider: 'workers-ai',
        apiFormat: 'openai',
        externalModelName: '@cf/text-model',
        apiKey: 'private-token',
      }),
    );
  });

  it.each([
    ['custom', { aUtHoRiZaTiOn: '********' }],
    ['custom', { 'X-Auth-Key': '********', 'X-Auth-Email': '********' }],
    ['workers-ai', { Authorization: '********' }],
    ['workers-ai', { 'X-Auth-Key': '********', 'X-Auth-Email': '********' }],
  ])('preserves existing Cloudflare header authentication for %s profiles', async (provider, customHeaders) => {
    const existing = {
      ...model,
      provider,
      apiKey: 'none',
      apiUrl: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions',
      customHeaders,
      externalModelName: '@cf/text-model',
    };
    const f = await fixture(undefined, [existing]);
    await f.click('Edit');
    expect(f.input('agy-api-key').value).toBe('');
    await f.click('Test connection');
    await f.click('Fetch provider models');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:test-model-connection',
      expect.objectContaining({ provider, apiKey: 'none', customHeaders }),
    );
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:discover-models',
      expect.objectContaining({ provider, apiKey: 'none', customHeaders }),
    );
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({ provider, apiKey: 'none', customHeaders }),
    );
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('edits and renames while roundtripping masked credentials and advanced options', async () => {
    const f = await fixture();
    await f.click('Edit');
    expect(f.input('agy-api-key').type).toBe('password');
    expect(f.input('agy-api-key').value).toBe('********');
    f.input('agy-model-name', 'models/renamed');
    f.input('agy-model-id', 'model-a-v2');
    f.input('agy-display-name', 'Updated model');
    f.input('agy-reasoning-effort', 'high');
    f.input('agy-thinking-budget', '2048');
    f.input('agy-max-output', '8192');
    f.input('agy-context-window', '128000');
    f.input('agy-timeout', '45000');
    f.input('agy-max-retries', '2');
    f.input('agy-vision', 'false');
    f.input('agy-raw-url', 'true');
    f.input('agy-fallback-models', 'models/backup, models/local');
    f.input('agy-extra-body', '{"temperature":0.2}');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        name: 'models/renamed',
        originalName: 'models/primary',
        externalModelName: 'model-a-v2',
        apiKey: '********',
        customHeaders: { 'X-Workspace': '********' },
        reasoningEffort: 'high',
        thinkingBudget: 2048,
        maxOutputTokens: 8192,
        contextWindow: 128000,
        timeout: 45000,
        maxRetries: 2,
        supportsVision: false,
        rawUrl: true,
        extraBody: { temperature: 0.2 },
        fallbackModels: ['models/backup', 'models/local'],
      }),
    );
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
    expect(f.document.querySelector('#agy-custom-models-content')!.textContent).toContain('Updated model');
  });

  it('duplicates with copyFrom and never renames the source record', async () => {
    const f = await fixture();
    await f.click('Duplicate');
    await f.click('Save model');
    const call = f.invoke.mock.calls.find(([channel]) => channel === 'storage:save-custom-model');
    expect(call?.[1]).toMatchObject({
      name: 'models/primary-copy',
      copyFrom: 'models/primary',
      apiKey: '********',
      customHeaders: { 'X-Workspace': '********' },
    });
    expect(call?.[1]).not.toHaveProperty('originalName');
    expect(f.getModels().map((value) => value.name)).toEqual(['models/primary', 'models/primary-copy']);
  });

  it('enables and disables a provider group while preserving each saved key', async () => {
    const f = await fixture(undefined, [
      model,
      { ...model, name: 'models/second', externalModelName: 'model-b', enabled: false },
    ]);
    await f.click('Enable group');
    expect(f.getModels().every((value) => value.enabled === true)).toBe(true);
    await f.click('Disable group');
    expect(f.getModels().every((value) => value.enabled === false && value.apiKey === '********')).toBe(true);
    expect(f.document.querySelectorAll('.agy-row[data-enabled="false"]')).toHaveLength(2);
  });

  it('discovers models with the saved identity and adds only selected IDs', async () => {
    const f = await fixture();
    await f.click('Discover models');
    await f.click('Fetch provider models');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:discover-models',
      expect.objectContaining({ name: model.name, apiKey: '********', apiUrl: model.apiUrl }),
    );
    expect(f.document.querySelector('#agy-modal-card script')).toBeNull();
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('<script>bad()</script>');
    await f.click('Select all');
    await f.click('Add selected');
    const saves = f.invoke.mock.calls
      .filter(([channel]) => channel === 'storage:save-custom-model')
      .map((call) => call[1] as Record<string, unknown>);
    expect(saves).toHaveLength(2);
    expect(saves.map((value) => value.externalModelName)).toEqual(['model-b', 'model-c']);
    expect(saves.every((value) => value.copyFrom === model.name && !value.originalName)).toBe(true);
  });

  it('configures discovered local servers without requiring a key or nonexistent copy source', async () => {
    const f = await fixture();
    await f.click('Discover local');
    await f.click('Configure');
    f.input('agy-model-id', 'local-model');
    await f.click('Save model');
    const call = f.invoke.mock.calls.find(([channel]) => channel === 'storage:save-custom-model');
    expect(call?.[1]).toMatchObject({ provider: 'ollama', apiKey: 'none', externalModelName: 'local-model' });
    expect(call?.[1]).not.toHaveProperty('copyFrom');
  });

  it('filters hundreds of provider models, retains selection across searches, and imports catalog metadata', async () => {
    const f = await fixture();
    f.handlers['storage:discover-models'] = () => ({
      success: true,
      models: Array.from({ length: 450 }, (_, i) => ({
        id: `vendor/model-${i}`,
        displayName: `Catalog model ${i}`,
        contextWindow: 65536,
        maxOutputTokens: 4096,
        supportsVision: true,
        supportsThinking: false,
      })),
    });
    await f.click('Discover models');
    await f.click('Fetch provider models');
    const search = f.input('agy-discovery-search', 'model-449');
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelectorAll('.agy-choice')).toHaveLength(1);
    await f.click('Select filtered');
    search.value = 'model-448';
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('1 selected');
    await f.click('Select filtered');
    search.value = 'missing';
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('No provider models match');
    await f.click('Add selected');
    const saved = f.getModels().filter((value) => value.name !== model.name);
    expect(saved.map((value) => value.externalModelName)).toEqual(['vendor/model-448', 'vendor/model-449']);
    expect(saved[0]).toMatchObject({
      contextWindow: 65536,
      maxOutputTokens: 4096,
      supportsVision: true,
      supportsThinking: false,
    });
  });

  it('keeps explicit limit overrides when importing catalog choices', async () => {
    const f = await fixture();
    f.handlers['storage:discover-models'] = () => ({
      success: true,
      models: [{ id: 'new-model', contextWindow: 32000, maxOutputTokens: 8000, supportsVision: true }],
    });
    await f.click('Discover models');
    f.input('agy-context-window', '16000');
    f.input('agy-max-output', '2048');
    f.input('agy-vision', 'false');
    await f.click('Fetch provider models');
    await f.click('Select all');
    await f.click('Add selected');
    expect(f.getModels().find((value) => value.externalModelName === 'new-model')).toMatchObject({
      contextWindow: 16000,
      maxOutputTokens: 2048,
      supportsVision: false,
    });
  });

  it('uses the redacted export endpoint and imports base64 without parsing it as JSON in the renderer', async () => {
    const f = await fixture();
    await f.click('Export');
    const exported = f.input('agy-config-json');
    expect(exported.value).not.toMatch(/apiKey|customHeaders|\*{8}/);
    expect(exported.readOnly).toBe(true);
    await f.click('Close');
    await f.click('Import');
    const encoded = Buffer.from('{"models":[]}').toString('base64');
    f.input('agy-config-json', encoded);
    await f.click('Import configuration');
    expect(f.invoke).toHaveBeenCalledWith('storage:import-custom-models', encoded);
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Imported 2 models');
  });

  it('shows validation and backend errors, retaining the form so the user can correct it', async () => {
    const f = await fixture();
    await f.click('Edit');
    f.input('agy-custom-headers', '{"Authorization":42}');
    await f.click('Save model');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Custom header values must be strings');
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:save-custom-model')).toBe(false);
    f.input('agy-custom-headers', '{}');
    f.handlers['storage:save-custom-model'] = () => ({ success: false, error: 'Configuration is read-only' });
    await f.click('Save model');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Configuration is read-only');
    expect(
      Array.from(f.document.querySelectorAll<HTMLButtonElement>('button')).find(
        (node) => node.textContent === 'Save model',
      )!.disabled,
    ).toBe(false);
  });

  it('keeps remote token masked while saving, testing, importing, and opening a dashboard', async () => {
    const f = await fixture();
    await f.click('Remote gateway');
    expect(f.input('agy-gateway-token').type).toBe('password');
    expect(f.input('agy-gateway-token').value).toBe('********');
    await f.click('Test gateway');
    expect(f.invoke).toHaveBeenCalledWith('storage:test-gateway', {
      url: 'https://gateway.example',
      token: '********',
      dashboardUrl: 'https://dashboard.example',
    });
    await f.click('Import model aliases');
    expect(f.invoke).toHaveBeenCalledWith('storage:save-gateway', expect.objectContaining({ token: '********' }));
    expect(f.invoke).toHaveBeenCalledWith('storage:import-gateway-models');
    await f.click('Open dashboard');
    expect(f.invoke).toHaveBeenCalledWith('storage:open-gateway-dashboard');
    f.handlers['storage:test-gateway'] = () => ({ success: false, error: 'Authentication rejected (HTTP 401)' });
    await f.click('Test gateway');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('HTTP 401');
  });

  it('filters disabled models from response injection and honors model limits', async () => {
    const f = await fixture(undefined, [
      { ...model, contextWindow: 32000, maxOutputTokens: 2048 },
      { ...model, name: 'models/disabled', externalModelName: 'disabled', enabled: false },
    ]);
    const response = await f.dom.window.fetch('http://127.0.0.1:50999/fetchAvailableModels');
    const result = await response.json();
    expect(result.models['custom-model-a']).toMatchObject({ maxTokens: 32000, maxOutputTokens: 2048 });
    expect(result.models['custom-disabled']).toBeUndefined();
  });

  it('edits a Google account pool without revealing persisted secrets', async () => {
    const savedAccount = {
      id: 'saved-account',
      label: 'Personal',
      refreshToken: '********',
      accessToken: '********',
      clientId: 'desktop.apps.googleusercontent.com',
      clientSecret: '********',
      authMode: 'antigravity',
      cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
      project: 'existing-project',
      enabled: true,
    };
    const f = await fixture(undefined, [
      {
        ...model,
        provider: 'google-cloudcode',
        apiFormat: 'google',
        apiKey: '',
        googleAccounts: [savedAccount],
        googlePool: { strategy: 'quota', maxConcurrency: 3, cooldownMs: 90000 },
      },
    ]);
    await f.click('Edit');
    expect(f.document.getElementById('agy-google-account-config')!.hidden).toBe(false);
    expect(f.input('agy-api-key').closest('label')!.hidden).toBe(true);
    await f.click('Test account');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-test-account', {
      modelName: model.name,
      accountId: 'saved-account',
    });
    await f.click('Edit account');
    expect(f.input('agy-account-refresh-token').type).toBe('password');
    expect(f.input('agy-account-client-secret').value).toBe('********');
    f.input('agy-account-label', 'Renamed account');
    await f.click('Apply account');
    f.input('agy-google-pool-strategy', 'round-robin');
    f.input('agy-google-project', 'my-project');
    await f.click('Test account');
    expect(f.invoke).toHaveBeenLastCalledWith('storage:google-test-account', {
      modelName: model.name,
      account: expect.objectContaining({ id: 'saved-account', label: 'Renamed account', refreshToken: '********' }),
    });
    await f.click('Test connection');
    expect(f.invoke).toHaveBeenLastCalledWith(
      'storage:test-model-connection',
      expect.objectContaining({
        name: model.name,
        googleAccounts: [expect.objectContaining({ id: 'saved-account', refreshToken: '********' })],
        googleProject: 'my-project',
        googlePool: { strategy: 'round-robin', maxConcurrency: 3, cooldownMs: 90000 },
      }),
    );
    await f.click('Fetch provider models');
    expect(f.invoke).toHaveBeenLastCalledWith(
      'storage:discover-models',
      expect.objectContaining({
        name: model.name,
        googleAccounts: [expect.objectContaining({ id: 'saved-account', refreshToken: '********' })],
        googleProject: 'my-project',
      }),
    );
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            id: 'saved-account',
            label: 'Renamed account',
            refreshToken: '********',
            clientSecret: '********',
            authMode: 'antigravity',
            cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
            project: 'existing-project',
          }),
        ],
        googleProject: 'my-project',
        googlePool: { strategy: 'round-robin', maxConcurrency: 3, cooldownMs: 90000 },
      }),
    );
  });

  it('keeps custom OAuth login available and saves the pending masked account', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    const provider = f.input('agy-provider', 'google-cloudcode');
    provider.dispatchEvent(new f.dom.window.Event('change'));
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:google-login')).toBe(false);
    f.input('agy-google-login-auth-mode', 'custom').dispatchEvent(new f.dom.window.Event('change'));
    expect(f.input('agy-google-login-client-id').closest('label')!.hidden).toBe(false);
    expect(f.input('agy-google-login-client-secret').closest('label')!.hidden).toBe(false);
    f.input('agy-google-login-client-id', 'desktop.apps.googleusercontent.com');
    f.input('agy-google-login-client-secret', 'user-entered-client-secret');
    f.input('agy-google-login-label', 'New account');
    await f.click('Sign in with Google');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login', {
      authMode: 'custom',
      clientId: 'desktop.apps.googleusercontent.com',
      clientSecret: 'user-entered-client-secret',
      label: 'New account',
    });
    expect(f.input('agy-google-login-client-secret').value).toBe('');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).toContain('New account');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).not.toContain('********');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('within 10 minutes');
    f.input('agy-model-id', 'gemini-model');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({ id: 'pending-account', refreshToken: '********', accessToken: '********' }),
        ],
      }),
    );
  });

  it('defaults to Antigravity login without client fields and retains the prepared account metadata', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    expect(f.input('agy-google-login-auth-mode').value).toBe('antigravity');
    expect(f.input('agy-google-login-client-id').closest('label')!.hidden).toBe(true);
    expect(f.input('agy-google-login-client-secret').closest('label')!.hidden).toBe(true);
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:google-login')).toBe(false);
    f.input('agy-google-login-label', 'Personal');
    await f.click('Sign in with Google');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login', { authMode: 'antigravity', label: 'Personal' });
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).toContain('prepared-project');
    await f.click('Edit account');
    f.input('agy-account-label', 'Prepared account');
    await f.click('Apply account');
    f.input('agy-model-id', 'gemini-model');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            authMode: 'antigravity',
            project: 'prepared-project',
            cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
            refreshToken: '********',
            accessToken: '********',
          }),
        ],
      }),
    );
  });

  it('prepares a saved account explicitly and retains masked credentials and the returned project', async () => {
    const f = await fixture(undefined, [
      {
        ...model,
        provider: 'google-cloudcode',
        googleAccounts: [
          { id: 'saved-account', clientId: 'desktop.apps.googleusercontent.com', refreshToken: '********' },
        ],
      },
    ]);
    await f.click('Edit');
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:google-account-prepare')).toBe(false);
    await f.click('Prepare account');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-account-prepare', {
      modelName: model.name,
      accountId: 'saved-account',
      allowOnboard: true,
    });
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Generation was not tested.');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).not.toContain('********');
    await f.click('Test account');
    expect(f.invoke).toHaveBeenLastCalledWith('storage:google-test-account', {
      modelName: model.name,
      account: expect.objectContaining({ id: 'saved-account', refreshToken: '********', project: 'prepared-project' }),
    });
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            id: 'saved-account',
            refreshToken: '********',
            project: 'prepared-project',
            cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
          }),
        ],
      }),
    );
  });

  it('imports user-owned account JSON without performing login or quota requests', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    f.input(
      'agy-google-account-json',
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'desktop.apps.googleusercontent.com',
        client_secret: 'entered-secret',
        refresh_token: 'entered-refresh',
        quota_project_id: 'owned-project',
        authMode: 'antigravity',
        cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
      }),
    );
    await f.click('Import accounts');
    expect(f.input('agy-google-account-json').value).toBe('');
    expect(
      f.invoke.mock.calls.some(([channel]) =>
        ['storage:google-login', 'storage:google-test-account', 'storage:google-account-prepare'].includes(channel),
      ),
    ).toBe(false);
    f.input('agy-model-id', 'gemini-model');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            clientId: 'desktop.apps.googleusercontent.com',
            refreshToken: 'entered-refresh',
            project: 'owned-project',
            authMode: 'antigravity',
            cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
          }),
        ],
      }),
    );
  });

  it('cancels an unfinished browser login when the model dialog closes', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    let finishLogin!: (value: unknown) => void;
    f.handlers['storage:google-login'] = () => new Promise((resolve) => (finishLogin = resolve));
    f.handlers['storage:google-login-cancel'] = () => {
      finishLogin({ success: false, error: 'Google login cancelled' });
      return { success: true };
    };
    f.input('agy-google-login-client-id', 'desktop.apps.googleusercontent.com');
    await f.click('Sign in with Google');
    await f.click('Close');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login-cancel');
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('cancels account preparation when the model dialog closes', async () => {
    const f = await fixture(undefined, [
      {
        ...model,
        provider: 'google-cloudcode',
        googleAccounts: [
          { id: 'saved-account', clientId: 'desktop.apps.googleusercontent.com', refreshToken: '********' },
        ],
      },
    ]);
    let finishPrepare!: (value: unknown) => void;
    f.handlers['storage:google-account-prepare'] = () => new Promise((resolve) => (finishPrepare = resolve));
    f.handlers['storage:google-login-cancel'] = () => {
      finishPrepare({ success: false, error: 'Account preparation cancelled' });
      return { success: true };
    };
    await f.click('Edit');
    await f.click('Prepare account');
    await f.click('Close');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login-cancel');
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('ignores a late successful login response after cancellation', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    let finishLogin!: (value: unknown) => void;
    f.handlers['storage:google-login'] = () => new Promise((resolve) => (finishLogin = resolve));
    await f.click('Sign in with Google');
    expect(f.input('agy-google-login-auth-mode').disabled).toBe(true);
    await f.click('Cancel Google login');
    finishLogin({ success: true, account: { id: 'late-account', accessToken: '********' } });
    await settle();
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).toContain(
      'No Google accounts configured.',
    );
    expect(f.input('agy-google-login-auth-mode').disabled).toBe(false);
  });

  it('surfaces an unavailable Antigravity installation without falling back to custom OAuth', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    f.handlers['storage:google-login'] = () => ({
      success: false,
      error: 'No recognized Antigravity installation found.',
    });
    await f.click('Sign in with Google');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain(
      'No recognized Antigravity installation found.',
    );
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'storage:google-login')).toHaveLength(1);
    expect(f.input('agy-google-login-auth-mode').value).toBe('antigravity');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).toContain(
      'No Google accounts configured.',
    );
  });

  it.each(['MCP', 'MCP Servers', 'Models & Usage'])(
    'does not interpret chat text %s as a settings heading',
    async (text) => {
      const f = await fixture(
        `<main data-testid="conversation-view"><div data-testid="autoscroll-viewport"><div><div role="article"><p><span>${text}</span></p><h2>${text}</h2></div><div><div><button>Refresh</button><span>Model Context Protocol</span></div></div></div></main></main>`,
      );
      expect(f.document.querySelector('#agy-custom-models-section')).toBeNull();
    },
  );

  it('mounts in the Settings dialog even when the conversation contains MCP first', async () => {
    const f = await fixture(
      '<main data-testid="conversation-view"><div role="article"><span>MCP</span></div></main><div role="dialog" aria-label="Settings"><main class="overflow-y-auto"><div id="model-settings"><h2><span>Models &amp; Usage</span></h2></div></main></div>',
      [model],
      'http://127.0.0.1:54321/c/conversation?settingsOpen=true',
    );
    expect(f.document.querySelector('#model-settings > #agy-custom-models-section')).toBeTruthy();
    expect(f.document.querySelector('[data-testid="conversation-view"] #agy-custom-models-section')).toBeNull();
  });

  it('removes an existing panel moved into the conversation and remounts it in Settings', async () => {
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section><main data-testid="conversation-view"></main>',
    );
    f.document
      .querySelector('[data-testid="conversation-view"]')!
      .append(f.document.getElementById('agy-custom-models-section')!);
    await vi.waitFor(() => expect(f.document.querySelector('#settings > #agy-custom-models-section')).toBeTruthy());
    expect(f.document.querySelector('[data-testid="conversation-view"] #agy-custom-models-section')).toBeNull();
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
  });

  it('removes the panel when its settings heading disappears without replacing the parent', async () => {
    const f = await fixture();
    f.document.querySelector('#settings h2')!.textContent = 'Appearance';
    await vi.waitFor(() => expect(f.document.querySelector('#agy-custom-models-section')).toBeNull());
  });

  it('requires a settings surface before accepting a generic Models & Usage heading', async () => {
    const f = await fixture(
      '<main><h2>Models &amp; Usage</h2></main>',
      [model],
      'http://127.0.0.1:54321/c/conversation',
    );
    expect(f.document.querySelector('#agy-custom-models-section')).toBeNull();
  });

  it('removes and restores the panel when the Settings dialog is hidden and shown', async () => {
    const f = await fixture(
      '<div role="dialog" aria-label="Settings"><section><h2>Models &amp; Usage</h2></section></div>',
      [model],
      'http://127.0.0.1:54321/c/conversation',
    );
    const dialog = f.document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('#agy-custom-models-section')).toBeTruthy();
    dialog.style.display = 'none';
    await vi.waitFor(() => expect(f.document.querySelector('#agy-custom-models-section')).toBeNull());
    dialog.style.display = '';
    await vi.waitFor(() => expect(dialog.querySelector('#agy-custom-models-section')).toBeTruthy());
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
  });

  it('renders Google Account Pool Quota overview and fleet table when accounts exist', async () => {
    const googleModel = {
      name: 'models/google-pool',
      displayName: 'Google Pool',
      provider: 'google-cloudcode',
      apiFormat: 'google',
      apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
      apiKey: '',
      externalModelName: 'gemini-3.8-flash-tiered',
      googlePool: { strategy: 'least-loaded' },
      googleAccounts: [
        { id: 'acc-1', label: 'Primary Account', project: 'aicode-consumers', enabled: true },
        { id: 'acc-2', label: 'Standby Account', project: 'aicode-consumers', enabled: true },
      ],
      enabled: true,
    };
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section>',
      [googleModel],
    );
    await vi.waitFor(() => {
      const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section');
      expect(widget).toBeTruthy();
      expect(widget?.hidden).toBe(false);
    });

    const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section')!;
    expect(widget.textContent).toContain('Google Account Fleet & Quota Overview');
    expect(widget.textContent).toContain('2 Accounts');
    expect(widget.textContent).toContain('Primary Account');
    expect(widget.textContent).toContain('Switcher Status');
    expect(widget.textContent).toContain('Account Fleet');

    const activeBadge = widget.querySelector('.agy-badge-active');
    expect(activeBadge).toBeTruthy();
    expect(activeBadge?.textContent).toContain('Active');

    const switchButtons = widget.querySelectorAll('.agy-btn-switch');
    expect(switchButtons).toHaveLength(1);
    expect(switchButtons[0].textContent).toContain('Switch');

    (switchButtons[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(f.invoke).toHaveBeenCalledWith(
        'storage:save-custom-model',
        expect.objectContaining({
          name: 'models/google-pool',
          googleAccounts: [
            expect.objectContaining({ id: 'acc-2' }),
            expect.objectContaining({ id: 'acc-1' }),
          ],
        }),
      );
    });
  });

  it('hides Google Account Pool widget when no Google Cloud Code accounts exist', async () => {
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section>',
      [model],
    );
    const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section');
    expect(widget?.hidden).toBe(true);
    const toolbarAddAccount = f.document.querySelector<HTMLButtonElement>('#agy-add-google-account');
    expect(toolbarAddAccount).toBeNull();
  });

  it('triggers direct Google OAuth browser login and syncs account to pool without duplicate', async () => {
    const googleModel = {
      name: 'models/google-pool',
      displayName: 'Google Pool',
      provider: 'google-cloudcode',
      apiFormat: 'google',
      apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
      apiKey: '',
      externalModelName: 'gemini-3.8-flash-tiered',
      googlePool: { strategy: 'least-loaded' },
      googleAccounts: [
        { id: 'acc-1', label: 'Existing Account', project: 'aicode-consumers', enabled: true },
      ],
      enabled: true,
    };
    const newAccount = {
      id: 'acc-new',
      label: 'New Connected Account',
      authMode: 'antigravity',
      project: 'aicode-consumers',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
      enabled: true,
    };
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section>',
      [googleModel],
    );
    await vi.waitFor(() => {
      const btn = f.document.querySelector<HTMLButtonElement>('#agy-pool-add-account-btn');
      expect(btn).toBeTruthy();
    });

    const fleetAddBtn = f.document.querySelector<HTMLButtonElement>('#agy-pool-add-account-btn')!;
    fleetAddBtn.click();

    await vi.waitFor(() => {
      expect(f.invoke).toHaveBeenCalledWith(
        'storage:google-login',
        expect.objectContaining({ authMode: 'antigravity' }),
      );
      expect(f.invoke).toHaveBeenCalledWith(
        'storage:save-custom-model',
        expect.objectContaining({
          name: 'models/google-pool',
          googleAccounts: expect.arrayContaining([
            expect.objectContaining({ id: 'acc-1' }),
            expect.objectContaining({ id: 'pending-account', label: 'New account' }),
          ]),
        }),
      );
    });
  });

  it('renders Gmail address in Fleet Table and active switcher cards when account has email', async () => {
    const googleModelWithEmail = {
      name: 'models/google-pool',
      displayName: 'Google Pool',
      provider: 'google-cloudcode',
      apiFormat: 'google',
      apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
      apiKey: '',
      externalModelName: 'gemini-3.8-flash-tiered',
      googleAccounts: [
        { id: 'acc-email-1', email: 'alice@gmail.com', label: 'Work Account', enabled: true },
        { id: 'acc-email-2', email: 'bob@gmail.com', label: 'Personal', enabled: false },
      ],
      enabled: true,
    };
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section>',
      [googleModelWithEmail],
    );
    await vi.waitFor(() => {
      const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section');
      expect(widget?.hidden).toBe(false);
    });

    const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section')!;
    const accountNames = [...widget.querySelectorAll('.agy-account-name')].map((el) => el.textContent);
    expect(accountNames).toContain('alice@gmail.com');
    expect(accountNames).toContain('bob@gmail.com');

    const accountSubtitles = [...widget.querySelectorAll('.agy-account-id')].map((el) => el.textContent);
    expect(accountSubtitles.some((text) => text?.includes('Work Account'))).toBe(true);
    expect(accountSubtitles.some((text) => text?.includes('Personal'))).toBe(true);

    const activeBadge = widget.querySelector('.agy-pool-badge-active');
    expect(activeBadge?.textContent).toContain('alice@gmail.com');
    expect(widget.textContent).toContain('PayG / GCP');
  });

  it('promotes healthy standby account to active in pool UI when primary account is quota-exhausted', async () => {
    const googleModelWithAccounts = {
      name: 'models/google-pool',
      displayName: 'Google Pool',
      provider: 'google-cloudcode',
      apiFormat: 'google',
      apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
      apiKey: '',
      externalModelName: 'gemini-3.8-flash-tiered',
      googleAccounts: [
        { id: 'acc-exhausted', email: 'exhausted@gmail.com', label: 'Exhausted Acc', enabled: true, authMode: 'antigravity' },
        { id: 'acc-healthy', email: 'healthy@gmail.com', label: 'Healthy Acc', enabled: true, authMode: 'antigravity' },
      ],
      enabled: true,
    };
    const f = await fixture(
      '<section id="settings"><h2>Models &amp; Usage</h2></section>',
      [googleModelWithAccounts],
    );
    f.handlers['storage:google-test-account'] = async (input: any) => {
      if (input.accountId === 'acc-exhausted') {
        return {
          success: true,
          quota: {
            accountId: 'acc-exhausted',
            email: 'exhausted@gmail.com',
            remainingFraction: 0,
            buckets: [
              { id: '5h', groupName: 'Gemini Models', remainingFraction: 0 },
              { id: '7d', groupName: 'Gemini Models', remainingFraction: 0 },
            ],
          },
        };
      }
      return {
        success: true,
        quota: {
          accountId: 'acc-healthy',
          email: 'healthy@gmail.com',
          remainingFraction: 1,
          buckets: [
            { id: '5h', groupName: 'Gemini Models', remainingFraction: 1 },
            { id: '7d', groupName: 'Gemini Models', remainingFraction: 1 },
          ],
        },
      };
    };

    await f.click('↻ Refresh Quotas');

    await vi.waitFor(() => {
      const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section');
      expect(widget?.hidden).toBe(false);
      const activeBadge = widget?.querySelector('.agy-pool-badge-active');
      expect(activeBadge?.textContent).toContain('healthy@gmail.com');
    });

    const widget = f.document.querySelector<HTMLElement>('#agy-google-account-pool-section')!;
    const activeBoxName = widget.querySelector('.agy-switcher-active-name');
    expect(activeBoxName?.textContent).toContain('healthy@gmail.com');
    expect(widget.textContent).toContain('Exhausted');
  });
});
