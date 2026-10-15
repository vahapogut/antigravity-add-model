/** Custom-model UI, appended to the vendor preload. Sandboxed preloads require Electron only. */
import { ipcRenderer } from 'electron';

interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  apiFormat?: string;
  enabled?: boolean;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  [key: string]: unknown;
}
interface ProviderPreset {
  id: string;
  label: string;
  defaultUrl: string;
  apiFormat: string;
  keyRequired: boolean;
}
interface ModelChoice {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}
interface ActionResult {
  success: boolean;
  error?: string;
  message?: string;
  count?: number;
  status?: number;
}
interface DiscoveryResult extends ActionResult {
  models?: ModelChoice[];
}
interface DiagnosticsSnapshot extends ActionResult {
  active: number;
  summary: Record<string, number>;
  recentModels: string[];
  requests: {
    model: string;
    provider: string;
    timestamp: number;
    outcome: string;
    status?: number;
    latencyMs: number;
    stream: boolean;
    kind: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }[];
}
interface GatewayConfig {
  url: string;
  token: string;
  dashboardUrl: string;
}
interface GoogleAccountEntry {
  id: string;
  label?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  project?: string;
  authMode?: 'custom' | 'antigravity';
  cloudCodeEndpoint?: string;
  enabled?: boolean;
}
const storageAPI = {
  getCustomModels: (): Promise<CustomModelEntry[]> => ipcRenderer.invoke('storage:get-custom-models'),
  saveCustomModel: (model: CustomModelEntry): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:save-custom-model', model),
  deleteCustomModel: (name: string): Promise<ActionResult> => ipcRenderer.invoke('storage:delete-custom-model', name),
  testModelConnection: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-connection', model),
  testModelGeneration: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-generation', model),
  getPresets: (): Promise<ProviderPreset[]> => ipcRenderer.invoke('storage:get-provider-presets'),
  discoverModels: (params: Partial<CustomModelEntry>): Promise<DiscoveryResult> =>
    ipcRenderer.invoke('storage:discover-models', params),
};

window.addEventListener('DOMContentLoaded', () => {
  let modelList: CustomModelEntry[] = [];
  let renderVersion = 0;
  let searchTerm = '';
  let cancelModalOperation: (() => void) | undefined;
  const requireSuccess = (result: ActionResult): ActionResult => {
    if (!result?.success) throw new Error(result?.error || 'The operation could not be completed.');
    return result;
  };
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function setStatus(target: HTMLElement, text: string, error = false): void {
    target.textContent = text;
    target.className = `agy-status${error ? ' agy-error' : ''}`;
  }
  function statusNode(): HTMLElement {
    const node = element('div', 'agy-status');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  }
  function button(
    label: string,
    action: () => void | Promise<void>,
    status?: HTMLElement,
    primary = false,
  ): HTMLButtonElement {
    const node = element('button', `agy-btn${primary ? ' agy-primary' : ''}`, label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      if (node.disabled) return;
      node.disabled = true;
      try {
        await action();
      } catch (error) {
        const target = status || document.getElementById('agy-main-status');
        if (target) setStatus(target, error instanceof Error ? error.message : String(error), true);
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }
  function field(parent: HTMLElement, title: string, id: string, value = '', type = 'text'): HTMLInputElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('input');
    input.id = id;
    input.type = type;
    input.value = value;
    input.autocomplete = 'off';
    label.append(input);
    parent.append(label);
    return input;
  }
  function selectField(
    parent: HTMLElement,
    title: string,
    id: string,
    options: [string, string][],
    value: string,
  ): HTMLSelectElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const select = element('select');
    select.id = id;
    for (const [key, caption] of options) {
      const option = element('option', '', caption);
      option.value = key;
      select.append(option);
    }
    select.value = value;
    label.append(select);
    parent.append(label);
    return select;
  }
  function jsonField(parent: HTMLElement, title: string, id: string, value: unknown): HTMLTextAreaElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('textarea');
    input.id = id;
    input.rows = 3;
    input.spellcheck = false;
    input.value = value ? JSON.stringify(value, null, 2) : '';
    input.placeholder = '{}';
    label.append(input);
    parent.append(label);
    return input;
  }
  function readJson(input: HTMLTextAreaElement, title: string): Record<string, unknown> | undefined {
    if (!input.value.trim()) return undefined;
    try {
      const value = JSON.parse(input.value);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
      return value;
    } catch {
      throw new Error(`${title} must be a JSON object.`);
    }
  }
  function readNumber(input: HTMLInputElement, title: string, minimum = 0): number | undefined {
    if (!input.value.trim()) return undefined;
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`${title} must be a whole number of at least ${minimum}.`);
    return value;
  }
  function validUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Enter a complete http:// or https:// API URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL. Enter credentials in the API key field.');
    return value.trim();
  }
  function installStyles(): void {
    if (typeof document?.createElement !== 'function' || !document?.head) return;
    if (document.getElementById?.('agy-manager-style')) return;
    const style = element('style');
    style.id = 'agy-manager-style';
    style.textContent = `
      #agy-custom-models-section,#agy-google-account-pool-section,#agy-modal-overlay{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e4e7;box-sizing:border-box}
      #agy-custom-models-section *,#agy-google-account-pool-section *,#agy-modal-overlay *{box-sizing:border-box}
      #agy-custom-models-section [hidden],#agy-google-account-pool-section [hidden],#agy-modal-overlay [hidden]{display:none!important}
      #agy-custom-models-section,#agy-google-account-pool-section{margin:24px 0;padding:20px;border:1px solid #303036;border-radius:12px;background:#18181b;min-width:0}
      #agy-custom-models-section h2,#agy-google-account-pool-section h2,#agy-modal-overlay h2{font-size:18px;margin:0;color:#fafafa;font-weight:600}
      #agy-custom-models-section h3,#agy-google-account-pool-section h3{font-size:13px;margin:0;color:#f4f4f5}
      .agy-toolbar,.agy-actions,.agy-group-heading,.agy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .agy-toolbar{justify-content:space-between;margin-bottom:12px}.agy-actions{margin:10px 0}
      .agy-muted{color:#a1a1aa;font-size:12px;overflow-wrap:anywhere}.agy-group{margin-top:16px;border-top:1px solid #303036;padding-top:14px}
      .agy-group-heading{justify-content:space-between}.agy-row{justify-content:space-between;border:1px solid #303036;border-radius:8px;padding:12px;margin-top:8px;background:#202024}
      .agy-row-info{flex:1;min-width:150px;overflow-wrap:anywhere}.agy-row[data-enabled="false"] .agy-row-info{opacity:.55}
      #agy-custom-models-section .agy-btn,#agy-google-account-pool-section .agy-btn,#agy-modal-overlay .agy-btn{appearance:none;font:inherit;color:#e4e4e7;background:#27272c;border:1px solid #414149;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
      #agy-custom-models-section .agy-primary,#agy-modal-overlay .agy-primary{background:#e4e4e7;color:#18181b;border-color:#e4e4e7;font-weight:600}
      #agy-custom-models-section .agy-btn:hover,#agy-google-account-pool-section .agy-btn:hover,#agy-modal-overlay .agy-btn:hover{filter:brightness(1.12)}
      #agy-custom-models-section .agy-btn:disabled,#agy-google-account-pool-section .agy-btn:disabled,#agy-modal-overlay .agy-btn:disabled{opacity:.5;cursor:wait}
      #agy-custom-models-section :focus-visible,#agy-google-account-pool-section :focus-visible,#agy-modal-overlay :focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
      .agy-status{color:#86efac;font-size:12px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}.agy-status:empty{display:none}.agy-error{color:#fca5a5}
      .agy-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;min-width:0;color:#a1a1aa}
      #agy-custom-models-section input,#agy-modal-overlay input,#agy-modal-overlay select,#agy-modal-overlay textarea{font:inherit;width:100%;background:#25252a;border:1px solid #414149;border-radius:6px;color:#fafafa;padding:8px 10px;min-width:0}
      #agy-modal-overlay textarea{font-family:ui-monospace,monospace;resize:vertical}#agy-modal-overlay input[type=checkbox]{width:auto;accent-color:#a78bfa}
      #agy-modal-overlay{position:fixed;inset:0;z-index:999999;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px}
      #agy-modal-card{width:680px;max-width:100%;max-height:90vh;overflow:auto;background:#18181b;border:1px solid #414149;border-radius:12px;padding:24px;box-shadow:0 24px 80px #0008}
      .agy-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.agy-discovery{max-height:240px;overflow:auto;margin:12px 0}
      .agy-choice{display:flex;gap:10px;align-items:center;padding:7px 0;overflow-wrap:anywhere}.agy-choice span{min-width:0}
      #agy-modal-overlay details{border:1px solid #303036;border-radius:8px;margin:12px 0;padding:12px}#agy-modal-overlay summary{cursor:pointer;margin-bottom:10px;font-weight:500}
      .agy-pool-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;background:#27272a;color:#a1a1aa;border:1px solid #3f3f46;white-space:nowrap}
      .agy-pool-badge-active{background:#064e3b;color:#34d399;border-color:#059669}
      .agy-pool-top-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
      .agy-pool-card{background:#202024;border:1px solid #303036;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;justify-content:space-between}
      .agy-pool-card-title{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#a1a1aa;font-weight:700;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
      .agy-pool-pill-status{font-size:10px;font-weight:600;color:#34d399;background:rgba(16,185,129,0.14);border:1px solid rgba(16,185,129,0.35);border-radius:10px;padding:1px 7px}
      .agy-switcher-active-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:6px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 6px 0;min-width:0}
      .agy-switcher-active-info{display:flex;flex-direction:column;gap:1px;min-width:0;overflow:hidden}
      .agy-switcher-active-label{font-size:9px;font-weight:700;color:#71717a;letter-spacing:0.5px;text-transform:uppercase}
      .agy-switcher-active-name{font-size:12.5px;font-weight:600;color:#fafafa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .agy-switcher-active-sub{font-size:10px;color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .agy-switcher-active-right{display:flex;align-items:center;flex-shrink:0}
      .agy-pool-plan-badge{font-size:10px;font-weight:600;color:#34d399;background:rgba(5,150,105,0.15);border:1px solid #059669;border-radius:4px;padding:2px 6px;white-space:nowrap}
      .agy-switcher-chips-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:auto}
      .agy-pool-chip{font-size:10px;font-weight:500;padding:2px 6px;border-radius:4px;background:#27272a;color:#a1a1aa;border:1px solid #38383e;white-space:nowrap}
      .agy-pool-gauges{display:flex;justify-content:space-around;align-items:center;gap:6px;margin-top:2px}
      .agy-pool-gauge-item{display:flex;flex-direction:column;align-items:center;text-align:center;min-width:0}
      .agy-pool-gauge-label{font-size:10px;font-weight:600;color:#e4e4e7;margin-top:3px;white-space:nowrap}
      .agy-pool-gauge-sub{font-size:9.5px;color:#a1a1aa;margin-top:1px;white-space:nowrap}
      .agy-fleet-section{background:#202024;border:1px solid #303036;border-radius:8px;padding:12px 14px;overflow-x:auto;max-width:100%}
      .agy-fleet-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
      .agy-fleet-table{width:100%;min-width:560px;border-collapse:collapse;table-layout:fixed}
      .agy-fleet-table th{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#a1a1aa;text-align:left;padding:6px 6px;border-bottom:1px solid #303036;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .agy-fleet-table td{padding:8px 6px;border-bottom:1px solid #27272a;vertical-align:middle;font-size:12px;overflow:hidden;text-overflow:ellipsis}
      .agy-fleet-table td:first-child{max-width:0;min-width:0;overflow:hidden}
      .agy-fleet-table th:last-child,.agy-fleet-table td:last-child{text-align:right;padding-right:4px;white-space:nowrap;min-width:76px;overflow:visible}
      .agy-fleet-table tr:last-child td{border-bottom:none}
      .agy-fleet-row-active{background:rgba(5,150,105,0.08)}
      .agy-fleet-table .agy-pool-badge{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;padding:2px 6px;font-size:10.5px;font-weight:600;box-sizing:border-box}
      .agy-account-info{display:flex;flex-direction:column;min-width:0;max-width:100%;overflow:hidden}
      .agy-account-name{font-weight:600;color:#fafafa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}
      .agy-account-id{font-size:10px;color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}
      .agy-bar-container{display:flex;flex-direction:column;gap:2px;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
      .agy-bar-track{height:6px;width:100%;background:#27272a;border-radius:3px;overflow:hidden;position:relative}
      .agy-bar-fill{height:100%;border-radius:3px;transition:width 0.4s ease}
      .agy-bar-meta{display:flex;justify-content:space-between;align-items:center;font-size:9.5px;gap:2px}
      .agy-bar-pct{font-weight:700;color:#e4e4e7;white-space:nowrap}
      .agy-bar-sub{color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .agy-badge-active,.agy-btn-switch{display:inline-flex;align-items:center;justify-content:center;gap:3px;width:68px;height:24px;border-radius:6px;font-size:10.5px;font-weight:600;letter-spacing:0.2px;box-sizing:border-box;white-space:nowrap;user-select:none;line-height:1}
      .agy-badge-active{background:rgba(16,185,129,0.14);color:#34d399;border:1px solid rgba(16,185,129,0.4);cursor:default}
      #agy-google-account-pool-section .agy-btn-switch{background:#27272a;color:#e4e4e7;border:1px solid #3f3f46;cursor:pointer;padding:0;transition:all 0.15s ease}
      #agy-google-account-pool-section .agy-btn-switch:hover{background:#3f3f46;border-color:#52525b;color:#ffffff;filter:none}
      #agy-google-account-pool-section .agy-btn-switch:active{background:#18181b}
      .agy-pool-refresh-btn{font-size:11px;padding:3px 8px;cursor:pointer}
      .agy-pool-add-btn{font-size:11px;padding:3px 10px;cursor:pointer;background:#059669;color:#ffffff;border:1px solid #10b981;border-radius:6px;font-weight:600}
      .agy-pool-add-btn:hover{background:#047857}
      .agy-model-search-box{padding:4px 6px 6px 6px;margin:2px 0;border-bottom:1px solid rgba(255,255,255,0.08);background:transparent}
      .agy-model-search-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:5px;color:#e4e4e7;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:4px 8px;outline:none;transition:border-color 0.15s ease}
      .agy-model-search-input:focus{border-color:rgba(255,255,255,0.28);background:rgba(255,255,255,0.08);outline:none;box-shadow:none}
      .agy-model-search-input::placeholder{color:#71717a}
      .agy-pool-groups-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;align-items:start}
      .agy-pool-groups-container{display:flex;flex-direction:column;gap:10px;width:100%}
      .agy-pool-group-col{display:flex;flex-direction:column;gap:4px;min-width:0}
      .agy-pool-group-block{display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06)}
      .agy-pool-group-block:last-child{border-bottom:none;padding-bottom:0}
      .agy-pool-group-header{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:600;margin-bottom:2px}
      .agy-pool-group-title{color:#e4e4e7;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .agy-pool-unavail-box{display:flex;align-items:center;justify-content:center;min-height:55px;padding:6px;background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.08);border-radius:6px;text-align:center}
      .agy-sub-bar-container{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0}
      .agy-sub-bar{display:flex;flex-direction:column;gap:2px;width:100%;min-width:0}
      .agy-sub-bar-meta{display:flex;justify-content:space-between;align-items:center;font-size:9.5px;gap:4px}
      .agy-sub-bar-tag{font-size:9px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;white-space:nowrap}
      @media(max-width:700px){.agy-pool-top-grid{grid-template-columns:1fr}}
      @media(max-width:600px){.agy-grid{grid-template-columns:1fr}#agy-modal-card{padding:16px}.agy-row .agy-actions{width:100%}}
    `;
    document.head.append(style);
  }
  function openModal(title: string): { body: HTMLElement; status: HTMLElement; close: () => void } {
    cancelModalOperation?.();
    cancelModalOperation = undefined;
    document.getElementById('agy-modal-overlay')?.remove();
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = element('div');
    overlay.id = 'agy-modal-overlay';
    const card = element('div');
    card.id = 'agy-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'agy-modal-title');
    const header = element('div', 'agy-toolbar');
    const heading = element('h2', '', title);
    heading.id = 'agy-modal-title';
    const close = () => {
      cancelModalOperation?.();
      cancelModalOperation = undefined;
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    header.append(heading, button('Close', close));
    const body = element('div');
    const status = statusNode();
    card.append(header, body, status);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        card.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,summary'),
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    document.body.append(overlay);
    header.querySelector('button')?.focus();
    return { body, status, close };
  }

  function createGoogleAccountPanel(
    parent: HTMLElement,
    initialAccounts: GoogleAccountEntry[],
    modelName?: string,
  ): () => GoogleAccountEntry[] {
    let accounts = initialAccounts.map((account) => ({ ...account }));
    const locallyEdited = new Set<string>();
    let accountOperationAttempt = 0;
    let accountOperationPending = false;
    const panel = element('details');
    panel.open = true;
    panel.append(element('summary', '', 'Google accounts'));
    panel.append(
      element(
        'p',
        'agy-muted',
        'Add up to 50 accounts you own using Antigravity sign-in, your Desktop OAuth client, or a credential file. Save the model to retain changes. Existing secrets stay masked. Prepare account checks the Cloud Code project and may activate the available free tier.',
      ),
    );
    const list = element('div');
    list.id = 'agy-google-accounts-list';
    const editor = element('div');
    const status = statusNode();
    const randomId = () => `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const addAccount = (account: GoogleAccountEntry) => {
      if (!account.id || (!account.refreshToken && !account.accessToken))
        throw new Error('An account needs an ID and a refresh token or access token.');
      if (account.refreshToken && !account.clientId)
        throw new Error('An OAuth client ID is required with a refresh token.');
      const index = accounts.findIndex((value) => value.id === account.id);
      if (index < 0) {
        if (accounts.length >= 50) throw new Error('A model can contain at most 50 Google accounts.');
        accounts.push(account);
      } else accounts[index] = account;
      locallyEdited.add(account.id);
      renderAccounts();
    };
    function editAccount(account?: GoogleAccountEntry): void {
      editor.replaceChildren();
      editor.append(element('h3', '', account ? 'Edit account' : 'Add account credentials'));
      const accountGrid = element('div', 'agy-grid');
      const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || randomId());
      const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || '');
      const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
      const clientSecret = field(
        accountGrid,
        'OAuth client secret (if required)',
        'agy-account-client-secret',
        account?.clientSecret || '',
        'password',
      );
      const refresh = field(
        accountGrid,
        'Refresh token',
        'agy-account-refresh-token',
        account?.refreshToken || '',
        'password',
      );
      const access = field(
        accountGrid,
        'Access token (optional with refresh token)',
        'agy-account-access-token',
        account?.accessToken || '',
        'password',
      );
      const expires = field(
        accountGrid,
        'Access token expiry (Unix milliseconds)',
        'agy-account-expires-at',
        account?.expiresAt != null ? String(account.expiresAt) : '',
        'number',
      );
      const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
      editor.append(accountGrid);
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Apply account',
          () => {
            const accountId = id.value.trim();
            if (account && accountId !== account.id && accounts.some((value) => value.id === accountId))
              throw new Error('That account ID already exists.');
            const updated: GoogleAccountEntry = {
              id: accountId,
              label: label.value.trim(),
              clientId: clientId.value.trim(),
              clientSecret: clientSecret.value.trim(),
              refreshToken: refresh.value.trim(),
              accessToken: access.value.trim(),
              expiresAt: readNumber(expires, 'Token expiry', 1),
              project: project.value.trim(),
              authMode: account?.authMode,
              cloudCodeEndpoint: account?.cloudCodeEndpoint,
              enabled: account?.enabled !== false,
            };
            // IDs bind masked secrets to their stored record, so changing an existing ID requires fresh credentials.
            if (
              account &&
              accountId !== account.id &&
              [updated.refreshToken, updated.accessToken, updated.clientSecret].some((value) => value?.includes('***'))
            )
              throw new Error('Keep the account ID unchanged when using masked credentials.');
            addAccount(updated);
            if (account && accountId !== account.id) accounts = accounts.filter((value) => value.id !== account.id);
            editor.replaceChildren();
            renderAccounts();
            setStatus(status, 'Account updated. Save the model to keep these changes.');
          },
          status,
        ),
        button('Cancel account edit', () => editor.replaceChildren(), status),
      );
      editor.append(actions);
    }
    function renderAccounts(): void {
      list.replaceChildren();
      if (!accounts.length) list.append(element('p', 'agy-muted', 'No Google accounts configured.'));
      for (const account of accounts) {
        const row = element('div', 'agy-row');
        const info = element('div', 'agy-row-info');
        info.append(
          element('strong', '', account.label || account.id),
          element(
            'div',
            'agy-muted',
            `${account.id} · ${account.enabled === false ? 'Disabled' : 'Enabled'}${account.project ? ` · ${account.project}` : ''}`,
          ),
        );
        const actions = element('div', 'agy-actions');
        actions.append(
          button('Edit account', () => editAccount(account), status),
          button(
            account.enabled === false ? 'Enable account' : 'Disable account',
            () => {
              account.enabled = account.enabled === false;
              renderAccounts();
            },
            status,
          ),
          button(
            'Test account',
            async () => {
              setStatus(status, 'Checking account access and quota…');
              const result = await ipcRenderer.invoke(
                'storage:google-test-account',
                modelName && !locallyEdited.has(account.id)
                  ? { modelName, accountId: account.id }
                  : { account, ...(modelName ? { modelName } : {}) },
              );
              requireSuccess(result);
              setStatus(
                status,
                result.message ||
                  (result.quota
                    ? `Account verified. Quota: ${JSON.stringify(result.quota)}`
                    : 'Account verified. Generation was not tested.'),
              );
            },
            status,
          ),
          button(
            'Prepare account',
            async () => {
              if (accountOperationPending)
                throw new Error('Wait for the current Google account operation or cancel it.');
              accountOperationPending = true;
              const attempt = ++accountOperationAttempt;
              const cancel = () => {
                accountOperationAttempt++;
                void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
              };
              cancelModalOperation = cancel;
              try {
                setStatus(status, 'Preparing account access and Cloud Code project…');
                const result = await ipcRenderer.invoke('storage:google-account-prepare', {
                  ...(modelName && !locallyEdited.has(account.id)
                    ? { modelName, accountId: account.id }
                    : { account, ...(modelName ? { modelName } : {}) }),
                  allowOnboard: true,
                });
                if (!panel.isConnected || accountOperationAttempt !== attempt) return;
                requireSuccess(result);
                if (!accounts.some((value) => value.id === account.id)) return;
                if (!result.account || result.account.id !== account.id)
                  throw new Error('Account preparation did not return the selected account.');
                addAccount({ ...account, ...(result.account as GoogleAccountEntry) });
                setStatus(
                  status,
                  result.message ||
                    'Account prepared. Save the model to retain the project. Generation was not tested.',
                );
              } finally {
                accountOperationPending = false;
                if (cancelModalOperation === cancel) cancelModalOperation = undefined;
              }
            },
            status,
          ),
          button(
            'Remove account',
            () => {
              accounts = accounts.filter((value) => value.id !== account.id);
              locallyEdited.delete(account.id);
              renderAccounts();
            },
            status,
          ),
        );
        row.append(info, actions);
        list.append(row);
      }
    }
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Add account', () => editAccount(), status),
      button(
        'Pool status',
        async () => {
          const result = await ipcRenderer.invoke('storage:google-pool-status');
          if (result?.success === false) requireSuccess(result);
          setStatus(status, JSON.stringify(result, null, 2));
        },
        status,
      ),
    );
    const login = element('details');
    login.append(element('summary', '', 'Sign in with Google'));
    const loginMode = selectField(
      login,
      'Sign-in method',
      'agy-google-login-auth-mode',
      [
        ['antigravity', 'Antigravity account'],
        ['custom', 'My Desktop OAuth client'],
      ],
      'antigravity',
    );
    const loginHelp = element('p', 'agy-muted');
    login.append(loginHelp);
    const loginLabel = field(login, 'Account label', 'agy-google-login-label');
    const loginClient = field(login, 'Desktop OAuth client ID', 'agy-google-login-client-id');
    const loginSecret = field(
      login,
      'OAuth client secret (if required)',
      'agy-google-login-client-secret',
      '',
      'password',
    );
    const updateLoginMode = () => {
      const native = loginMode.value === 'antigravity';
      loginClient.closest('label')!.hidden = native;
      loginSecret.closest('label')!.hidden = native;
      loginHelp.textContent = native
        ? 'Sign in through your browser using the installed Antigravity app’s OAuth client. This prepares your Cloud Code project and may activate the available free tier. A recognized Antigravity installation is required. Repeat for each account, then save the model. Generation must be tested separately.'
        : 'Enter a Desktop OAuth client from your Google Cloud project. Your project and account must have access to the configured Cloud Code service. Repeat Sign in with Google for each account, then save the model.';
    };
    loginMode.addEventListener('change', updateLoginMode);
    updateLoginMode();
    const loginActions = element('div', 'agy-actions');
    loginActions.append(
      button(
        'Sign in with Google',
        async () => {
          const authMode = loginMode.value === 'custom' ? 'custom' : 'antigravity';
          if (authMode === 'custom' && !loginClient.value.trim())
            throw new Error('Enter your Desktop OAuth client ID.');
          if (accountOperationPending) throw new Error('Wait for the current Google account operation or cancel it.');
          accountOperationPending = true;
          const attempt = ++accountOperationAttempt;
          const cancel = () => {
            accountOperationAttempt++;
            void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
          };
          cancelModalOperation = cancel;
          for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = true;
          setStatus(
            status,
            authMode === 'antigravity'
              ? 'Complete consent in your browser, then wait for account preparation. Browser login expires after two minutes.'
              : 'Complete consent in your browser. This login expires after two minutes.',
          );
          try {
            const result = await ipcRenderer.invoke('storage:google-login', {
              authMode,
              ...(authMode === 'custom'
                ? { clientId: loginClient.value.trim(), clientSecret: loginSecret.value.trim() || undefined }
                : {}),
              label: loginLabel.value.trim() || undefined,
            });
            if (!panel.isConnected || accountOperationAttempt !== attempt) return;
            requireSuccess(result);
            if (!result.account) throw new Error('Google login did not return an account.');
            addAccount(result.account as GoogleAccountEntry);
            loginSecret.value = '';
            setStatus(
              status,
              'Account authorized. Save the model within 10 minutes to retain it; otherwise sign in again. Use Test account to check service access and quota, then Test generation to verify a model response.',
            );
          } finally {
            accountOperationPending = false;
            for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = false;
            if (cancelModalOperation === cancel) cancelModalOperation = undefined;
          }
        },
        status,
      ),
      button(
        'Cancel Google login',
        async () => {
          accountOperationAttempt++;
          requireSuccess(await ipcRenderer.invoke('storage:google-login-cancel'));
          cancelModalOperation = undefined;
          setStatus(status, 'Google login cancelled.');
        },
        status,
      ),
    );
    login.append(loginActions);
    const importer = element('details');
    importer.append(element('summary', '', 'Import account credentials'));
    importer.append(
      element(
        'p',
        'agy-muted',
        'Import your own authorized_user JSON, an account object, or an accounts array. Importing does not open a browser or make network requests.',
      ),
    );
    const accountJson = jsonField(importer, 'Account JSON', 'agy-google-account-json', undefined);
    const file = field(importer, 'Credential JSON file', 'agy-google-account-file', '', 'file');
    file.accept = '.json,application/json';
    file.addEventListener('change', async () => {
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 512 * 1024) throw new Error('Account files must be smaller than 512 KB.');
        accountJson.value = await selected.text();
      } catch (error) {
        setStatus(status, String(error), true);
      }
    });
    importer.append(
      button(
        'Import accounts',
        () => {
          let data: unknown;
          try {
            data = JSON.parse(accountJson.value);
          } catch {
            throw new Error('Account credentials must be valid JSON.');
          }
          const root = data as { accounts?: unknown[]; googleAccounts?: unknown[] };
          const values = Array.isArray(data) ? data : root?.accounts || root?.googleAccounts || [data];
          if (!Array.isArray(values) || !values.length || values.length + accounts.length > 50)
            throw new Error('Import between 1 and 50 accounts.');
          const incoming = values.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Each account must be a JSON object.');
            const entry = value as Record<string, unknown>;
            const text = (key: string, alternate = key): string => String(entry[key] || entry[alternate] || '');
            const account: GoogleAccountEntry = {
              id: text('id') || randomId(),
              label: text('label', 'accountEmail') || 'Imported account',
              refreshToken: text('refreshToken', 'refresh_token'),
              accessToken: text('accessToken', 'access_token'),
              clientId: text('clientId', 'client_id'),
              clientSecret: text('clientSecret', 'client_secret'),
              project: text('project', 'quota_project_id'),
              ...(entry.authMode === 'custom' || entry.authMode === 'antigravity' ? { authMode: entry.authMode } : {}),
              ...(entry.cloudCodeEndpoint ? { cloudCodeEndpoint: text('cloudCodeEndpoint') } : {}),
              enabled: entry.enabled !== false,
              ...(entry.expiresAt != null ? { expiresAt: Number(entry.expiresAt) } : {}),
            };
            if (!account.refreshToken && !account.accessToken)
              throw new Error('An imported account must contain a refresh token or access token.');
            if (account.refreshToken && !account.clientId)
              throw new Error('An imported refresh token requires its OAuth client ID.');
            return account;
          });
          for (const account of incoming) addAccount(account);
          accountJson.value = '';
          file.value = '';
          setStatus(status, `Imported ${incoming.length} accounts. Save the model to encrypt and retain them.`);
        },
        status,
      ),
    );
    panel.append(list, actions, editor, login, importer, status);
    parent.append(panel);
    renderAccounts();
    return () => accounts.map((account) => ({ ...account }));
  }
  const nonSettingsContent =
    '#agy-custom-models-section,#agy-modal-overlay,button,nav,[role="tablist"],article,[role="article"],pre,code,' +
    '[data-testid="conversation-view"],[data-testid="autoscroll-viewport"],[role="log"]';
  function isSettingsContent(node: HTMLElement): boolean {
    if (node.closest(nonSettingsContent)) return false;
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function findRefreshButton(root: ParentNode): HTMLButtonElement | null {
    return (
      Array.from(root.querySelectorAll('button')).find(
        (node) =>
          !node.closest('#agy-custom-models-section') &&
          isSettingsContent(node.parentElement || node) &&
          (node.textContent?.trim() === 'Refresh' ||
            /refresh quota/i.test(`${node.getAttribute('aria-label') || ''} ${node.title || ''}`)),
      ) || null
    );
  }
  async function modelsChanged(): Promise<void> {
    customModelsCache.ts = 0;
    await renderCustomModelsList();
    const mount = findSettingsMount();
    if (mount) findRefreshButton(mount)?.click();
  }
  function uniqueName(base: string): string {
    let name = base,
      index = 2;
    while (modelList.some((model) => model.name === name)) name = `${base}-${index++}`;
    return name;
  }
  function openDeleteModelModal(model: CustomModelEntry): void {
    const { body, status, close } = openModal('Delete model');
    body.append(
      element('p', '', `Delete “${model.displayName || model.name}”?`),
      element('p', 'agy-muted', 'This removes the saved model configuration from this app.'),
    );
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Cancel', close),
      button(
        'Delete model',
        async () => {
          setStatus(status, 'Deleting model…');
          requireSuccess(await storageAPI.deleteCustomModel(model.name));
          // The user may have closed this dialog while storage was updating.
          const dialogStillOpen = body.isConnected;
          if (dialogStillOpen) close();
          await modelsChanged();
          if (dialogStillOpen && !document.getElementById('agy-modal-overlay'))
            document.getElementById('agy-add-model')?.focus();
        },
        status,
        true,
      ),
    );
    body.append(actions);
  }

  const poolQuotaCache = new Map<string, { quota?: any; error?: string; timestamp: number }>();
  let isRefreshingPoolQuotas = false;
  let poolWidgetInterval: ReturnType<typeof setInterval> | undefined;

  interface QuotaGroupSummary {
    name: string;
    displayName: string;
    isGemini: boolean;
    isThirdParty: boolean;
    hasBuckets: boolean;
    fiveHour: { fraction: number; resetTime?: string };
    weekly: { fraction: number; resetTime?: string };
    unavailable?: boolean;
    notice?: string;
  }

  interface ParsedQuotaSummary {
    hasBuckets: boolean;
    groups: QuotaGroupSummary[];
    gemini?: QuotaGroupSummary;
    thirdParty?: QuotaGroupSummary;
    fiveHour: { fraction: number; resetTime?: string };
    weekly: { fraction: number; resetTime?: string };
  }

  function parseQuotaBuckets(quota?: any, isCustomAuth = false): ParsedQuotaSummary {
    const emptyResult: ParsedQuotaSummary = {
      hasBuckets: false,
      groups: [],
      fiveHour: { fraction: 1.0 },
      weekly: { fraction: 1.0 },
    };
    if (isCustomAuth) return emptyResult;

    function extractGroupBuckets(bList: any[], defaultFraction = 1.0) {
      let fiveHour = bList.find((b) => /5h|five|hour/i.test(b.id || b.bucketId || b.displayName || ''));
      let weekly = bList.find((b) => /week|7d|seven|day/i.test(b.id || b.bucketId || b.displayName || ''));

      if (!fiveHour || !weekly) {
        for (const b of bList) {
          if (b === fiveHour || b === weekly) continue;
          if (b.resetTime) {
            const hours = (Date.parse(b.resetTime) - Date.now()) / 3600000;
            if (hours > 0 && hours <= 24 && !fiveHour) fiveHour = b;
            else if (hours > 24 && !weekly) weekly = b;
          }
        }
      }

      if (!fiveHour && bList[0] && bList[0] !== weekly) fiveHour = bList[0];
      if (!weekly && bList[1] && bList[1] !== fiveHour) weekly = bList[1];

      const fFraction = fiveHour?.remainingFraction ?? (bList.length === 1 ? defaultFraction : 1.0);
      const wFraction = weekly?.remainingFraction ?? defaultFraction;

      return {
        fiveHour: { fraction: fFraction, resetTime: fiveHour?.resetTime },
        weekly: { fraction: wFraction, resetTime: weekly?.resetTime },
      };
    }

    const defaultFraction = typeof quota?.remainingFraction === 'number' ? quota.remainingFraction : 1.0;
    const groups: QuotaGroupSummary[] = [];

    if (Array.isArray(quota?.groups) && quota.groups.length > 0) {
      for (const g of quota.groups) {
        const rawName = String(g.displayName || g.name || 'Models').trim();
        const bList = Array.isArray(g.buckets) ? g.buckets : [];
        const isThirdParty = /claude|gpt|anthropic|openai|third[- ]?party/i.test(rawName);
        const isGemini = /gemini/i.test(rawName) || (!isThirdParty && groups.length === 0);
        const parsed = extractGroupBuckets(bList, defaultFraction);
        groups.push({
          name: rawName,
          displayName: rawName,
          isGemini,
          isThirdParty,
          hasBuckets: bList.length > 0,
          fiveHour: parsed.fiveHour,
          weekly: parsed.weekly,
        });
      }
    } else if (Array.isArray(quota?.buckets) && quota.buckets.length > 0) {
      const byGroup = new Map<string, any[]>();
      for (const b of quota.buckets) {
        const gName = b.groupName || (
          /claude|gpt|anthropic|openai/i.test(b.id || b.bucketId || '') ? 'Claude and GPT models' : 'Gemini Models'
        );
        if (!byGroup.has(gName)) byGroup.set(gName, []);
        byGroup.get(gName)!.push(b);
      }

      for (const [gName, bList] of byGroup.entries()) {
        const isThirdParty = /claude|gpt|anthropic|openai|third[- ]?party/i.test(gName);
        const isGemini = /gemini/i.test(gName) || (!isThirdParty && groups.length === 0);
        const parsed = extractGroupBuckets(bList, defaultFraction);
        groups.push({
          name: gName,
          displayName: gName,
          isGemini,
          isThirdParty,
          hasBuckets: bList.length > 0,
          fiveHour: parsed.fiveHour,
          weekly: parsed.weekly,
        });
      }
    }

    const hasBuckets = groups.some((g) => g.hasBuckets) || (typeof quota?.remainingFraction === 'number' && quota.remainingFraction < 1.0);
    if (!hasBuckets && !quota?.buckets && !quota?.groups) {
      return emptyResult;
    }

    const gemini = groups.find((g) => g.isGemini) || groups[0];
    const thirdParty = groups.find((g) => g.isThirdParty);

    // Fallback virtual group for third-party models if not in the response
    if (gemini && !thirdParty && quota?.planTier) {
      const planLower = String(quota.planTier).toLowerCase();
      const isFree = planLower.includes('free');
      groups.push({
        name: 'Third-party models',
        displayName: 'Claude and GPT models',
        isGemini: false,
        isThirdParty: true,
        hasBuckets: false,
        unavailable: true,
        notice: isFree ? 'Not in Free tier' : 'Unavailable on plan',
        fiveHour: { fraction: 0 },
        weekly: { fraction: 0 },
      });
    }

    const primaryGroup = gemini || groups[0] || { fiveHour: { fraction: 1.0 }, weekly: { fraction: 1.0 } };

    return {
      hasBuckets: true,
      groups,
      gemini,
      thirdParty,
      fiveHour: primaryGroup.fiveHour,
      weekly: primaryGroup.weekly,
    };
  }

  function formatResetHorizon(resetTime?: string, fraction = 1): string {
    if (fraction >= 1) return 'Full';
    if (!resetTime) return 'Active';
    const diffMs = Date.parse(resetTime) - Date.now();
    if (diffMs <= 0) return 'Refreshed';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(diffMs / 3600000);
    const remMins = Math.floor((diffMs % 3600000) / 60000);
    if (hours < 24) return `in ${hours}h ${remMins}m`;
    const days = Math.floor(diffMs / 86400000);
    const remHours = Math.floor((diffMs % 86400000) / 3600000);
    return `in ${days}d ${remHours}h`;
  }

  function renderCircleArc(fraction: number, size = 64, strokeWidth = 5): HTMLElement {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    const offset = circumference - (clamped / 100) * circumference;

    let strokeColor = '#34d399';
    if (clamped < 20) strokeColor = '#f87171';
    else if (clamped < 50) strokeColor = '#fbbf24';

    const wrapper = element('div');
    wrapper.style.position = 'relative';
    wrapper.style.width = `${size}px`;
    wrapper.style.height = `${size}px`;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.transform = 'rotate(-90deg)';

    const bgCircle = document.createElementNS(svgNS, 'circle');
    bgCircle.setAttribute('cx', String(size / 2));
    bgCircle.setAttribute('cy', String(size / 2));
    bgCircle.setAttribute('r', String(radius));
    bgCircle.setAttribute('fill', 'none');
    bgCircle.setAttribute('stroke', '#27272a');
    bgCircle.setAttribute('stroke-width', String(strokeWidth));
    svg.appendChild(bgCircle);

    const progCircle = document.createElementNS(svgNS, 'circle');
    progCircle.setAttribute('cx', String(size / 2));
    progCircle.setAttribute('cy', String(size / 2));
    progCircle.setAttribute('r', String(radius));
    progCircle.setAttribute('fill', 'none');
    progCircle.setAttribute('stroke', strokeColor);
    progCircle.setAttribute('stroke-width', String(strokeWidth));
    progCircle.setAttribute('stroke-dasharray', String(circumference));
    progCircle.setAttribute('stroke-dashoffset', String(offset));
    progCircle.setAttribute('stroke-linecap', 'round');
    progCircle.style.transition = 'stroke-dashoffset 0.5s ease';
    svg.appendChild(progCircle);

    const textOverlay = element('div');
    textOverlay.style.position = 'absolute';
    textOverlay.style.inset = '0';
    textOverlay.style.display = 'flex';
    textOverlay.style.alignItems = 'center';
    textOverlay.style.justifyContent = 'center';
    textOverlay.style.flexDirection = 'column';

    const pctSpan = element('span', '', `${clamped}%`);
    pctSpan.style.fontSize = size <= 48 ? '10.5px' : (size <= 64 ? '13px' : '18px');
    pctSpan.style.fontWeight = '700';
    pctSpan.style.color = '#fafafa';
    textOverlay.appendChild(pctSpan);

    wrapper.append(svg, textOverlay);
    return wrapper;
  }

  function isAccountQuotaExhausted(accountId: string, authMode?: string): boolean {
    // Non-antigravity accounts (custom GCP OAuth / own credentials) do not have the Cloud Code tiered quota system
    if (authMode !== 'antigravity') return false;
    const cached = poolQuotaCache.get(accountId);
    if (!cached) return false;
    if (cached.error && /exhausted|quota|429|resource/i.test(cached.error)) return true;
    if (!cached.quota) return false;
    const parsed = parseQuotaBuckets(cached.quota, false);
    if (parsed.hasBuckets) {
      if (parsed.gemini && (parsed.gemini.fiveHour.fraction === 0 || parsed.gemini.weekly.fraction === 0)) {
        return true;
      }
      const availableGroups = parsed.groups.filter((g) => !g.unavailable && g.hasBuckets);
      if (availableGroups.length > 0 && availableGroups.every((g) => g.fiveHour.fraction === 0 || g.weekly.fraction === 0)) {
        return true;
      }
    }
    if (typeof cached.quota.remainingFraction === 'number' && cached.quota.remainingFraction === 0) {
      return true;
    }
    return false;
  }

  function resolveActivePoolAccount(accounts: GoogleAccountEntry[]): GoogleAccountEntry | undefined {
    const enabled = accounts.filter((a) => a.enabled !== false);
    if (!enabled.length) return accounts[0];
    const healthy = enabled.find((a) => !isAccountQuotaExhausted(a.id, a.authMode));
    return healthy || enabled[0];
  }

  function extractPoolAccounts(models: CustomModelEntry[]): {
    accounts: GoogleAccountEntry[];
    activeAccount: GoogleAccountEntry | undefined;
    poolStrategy: string;
    modelName: string;
  } {
    const googleModels = models.filter((m) => m.provider === 'google-cloudcode' || Array.isArray(m.googleAccounts));
    if (!googleModels.length) {
      return { accounts: [], activeAccount: undefined, poolStrategy: 'least-loaded', modelName: '' };
    }
    const firstModel = googleModels[0];
    const strategy = (firstModel.googlePool as { strategy?: string } | undefined)?.strategy || 'least-loaded';
    const seen = new Set<string>();
    const accounts: GoogleAccountEntry[] = [];
    for (const model of googleModels) {
      if (Array.isArray(model.googleAccounts)) {
        for (const account of model.googleAccounts as GoogleAccountEntry[]) {
          if (account && account.id && !seen.has(account.id)) {
            seen.add(account.id);
            accounts.push(account);
          }
        }
      }
    }
    const activeAccount = resolveActivePoolAccount(accounts);
    return { accounts, activeAccount, poolStrategy: strategy, modelName: firstModel.name };
  }

  async function switchPoolActiveAccount(targetAccountId: string): Promise<void> {
    const models = await storageAPI.getCustomModels();
    let updatedCount = 0;
    for (const model of models) {
      if ((model.provider === 'google-cloudcode' || Array.isArray(model.googleAccounts)) && Array.isArray(model.googleAccounts)) {
        const idx = model.googleAccounts.findIndex((a: any) => a.id === targetAccountId);
        if (idx > 0) {
          const [chosen] = model.googleAccounts.splice(idx, 1);
          model.googleAccounts.unshift(chosen);
          requireSuccess(await storageAPI.saveCustomModel(model));
          updatedCount++;
        }
      }
    }
    if (updatedCount > 0) {
      await modelsChanged();
    }
  }

  async function quickAddGoogleAccount(triggerBtn?: HTMLButtonElement): Promise<void> {
    const originalText = triggerBtn?.textContent || '+ Add Account';
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Opening browser…';
    }

    let cancelBtn: HTMLButtonElement | undefined;
    let statusBanner: HTMLElement | undefined;

    const poolSection = document.getElementById('agy-google-account-pool-section');
    const targetMount = (!poolSection || poolSection.hidden)
      ? document.getElementById('agy-custom-models-section')
      : poolSection;

    if (targetMount) {
      statusBanner = element('div', 'agy-pool-login-banner');
      statusBanner.style.background = 'rgba(56, 189, 248, 0.1)';
      statusBanner.style.border = '1px solid rgba(56, 189, 248, 0.3)';
      statusBanner.style.borderRadius = '8px';
      statusBanner.style.padding = '10px 14px';
      statusBanner.style.margin = '10px 0';
      statusBanner.style.display = 'flex';
      statusBanner.style.alignItems = 'center';
      statusBanner.style.justifyContent = 'space-between';
      statusBanner.style.fontSize = '12px';
      statusBanner.style.color = '#38bdf8';

      const msg = element('span', '', 'Waiting for Google sign-in in your browser… Complete consent to link account.');
      cancelBtn = button('Cancel', async () => {
        cancelBtn!.disabled = true;
        cancelBtn!.textContent = 'Cancelling…';
        try {
          await ipcRenderer.invoke('storage:google-login-cancel');
        } catch {}
        statusBanner?.remove();
        if (triggerBtn) {
          triggerBtn.disabled = false;
          triggerBtn.textContent = originalText;
        }
      });
      cancelBtn.className = 'agy-btn';
      cancelBtn.style.padding = '3px 10px';
      cancelBtn.style.fontSize = '11px';

      statusBanner.append(msg, cancelBtn);
      targetMount.prepend(statusBanner);
    }

    try {
      if (triggerBtn) triggerBtn.textContent = 'Waiting for consent…';
      const result = (await ipcRenderer.invoke('storage:google-login', {
        authMode: 'antigravity',
      })) as { success?: boolean; account?: GoogleAccountEntry; error?: string };

      if (!result || result.success === false || !result.account) {
        if (result?.error && !result.error.includes('cancelled')) {
          alert(`Google login failed: ${result.error}`);
        }
        return;
      }

      const newAccount = result.account;
      if (triggerBtn) triggerBtn.textContent = 'Syncing account pool…';

      const models = await storageAPI.getCustomModels();
      let poolModelFound = false;

      for (const model of models) {
        if (model.provider === 'google-cloudcode' || Array.isArray(model.googleAccounts)) {
          poolModelFound = true;
          const accs = Array.isArray(model.googleAccounts)
            ? (model.googleAccounts as GoogleAccountEntry[])
            : [];
          model.googleAccounts = accs;

          const existingIdx = accs.findIndex(
            (a) =>
              a.id === newAccount.id ||
              (newAccount.email && a.email && a.email.toLowerCase() === newAccount.email.toLowerCase()) ||
              (newAccount.label && a.label && a.label.trim().toLowerCase() === newAccount.label.trim().toLowerCase())
          );

          if (existingIdx >= 0) {
            accs[existingIdx] = {
              ...accs[existingIdx],
              ...newAccount,
              id: accs[existingIdx].id || newAccount.id,
              email: newAccount.email || accs[existingIdx].email,
              label:
                newAccount.label && newAccount.label.toLowerCase() !== 'google account'
                  ? newAccount.label
                  : (accs[existingIdx].label && accs[existingIdx].label.toLowerCase() !== 'google account'
                      ? accs[existingIdx].label
                      : (newAccount.label || 'Google account')),
              enabled: true,
            };
          } else {
            accs.push({
              ...newAccount,
              enabled: true,
            });
          }

          requireSuccess(await storageAPI.saveCustomModel(model));
        }
      }

      if (!poolModelFound) {
        const defaultPoolModel: CustomModelEntry = {
          name: 'models/google-pool',
          displayName: 'Google Cloud Code (Account Pool)',
          provider: 'google-cloudcode',
          apiFormat: 'google',
          apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
          apiKey: '',
          externalModelName: 'gemini-3.8-flash-tiered',
          googlePool: { strategy: 'least-loaded', maxConcurrency: 2, cooldownMs: 60000 },
          googleAccounts: [{ ...newAccount, enabled: true }],
          enabled: true,
        };
        requireSuccess(await storageAPI.saveCustomModel(defaultPoolModel));
      }

      await modelsChanged();
    } catch (err: any) {
      if (!err?.message?.includes('cancelled')) {
        alert(`Could not add account: ${err?.message || err}`);
      }
    } finally {
      statusBanner?.remove();
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalText;
      }
    }
  }

  async function renderGooglePoolWidget(models: CustomModelEntry[]): Promise<void> {
    const container = document.getElementById('agy-google-account-pool-section');
    if (!container) return;
    const pool = extractPoolAccounts(models);
    if (!pool.accounts.length) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    container.hidden = false;
    container.replaceChildren();

    const activeIds = new Set(pool.accounts.map((a) => a.id));
    for (const cachedId of poolQuotaCache.keys()) {
      if (!activeIds.has(cachedId)) poolQuotaCache.delete(cachedId);
    }

    const header = element('div', 'agy-toolbar');
    const titleGroup = element('div');
    titleGroup.style.display = 'flex';
    titleGroup.style.alignItems = 'center';
    titleGroup.style.gap = '10px';
    titleGroup.style.flexWrap = 'wrap';

    const heading = element('h2', '', 'Google Account Fleet & Quota Overview');
    const badgeCount = element('span', 'agy-pool-badge', `${pool.accounts.length} Accounts`);
    titleGroup.append(heading, badgeCount);

    const actions = element('div', 'agy-actions');
    actions.style.margin = '0';
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '8px';
    actions.style.flexWrap = 'wrap';

    if (pool.activeAccount) {
      const activeQuota = poolQuotaCache.get(pool.activeAccount.id)?.quota;
      const activeEmail = activeQuota?.email || pool.activeAccount.email;
      const activeDisplay = activeEmail || pool.activeAccount.label || pool.activeAccount.id;
      actions.append(
        element('span', 'agy-pool-badge agy-pool-badge-active', `Active: ${activeDisplay}`)
      );
    }

    const addAccountFleet = button('+ Add Account', () => quickAddGoogleAccount(addAccountFleet), undefined, true);
    addAccountFleet.className = 'agy-btn agy-btn-primary agy-pool-add-btn';
    addAccountFleet.id = 'agy-pool-add-account-btn';
    const refreshBtn = button('↻ Refresh Quotas', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      for (const a of pool.accounts) poolQuotaCache.delete(a.id);
      await fetchAllQuotas();
      void renderGooglePoolWidget(modelList);
    });
    refreshBtn.className = 'agy-btn agy-pool-refresh-btn';
    actions.append(addAccountFleet, refreshBtn);
    header.append(titleGroup, actions);

    const desc = element('p', 'agy-muted', 'Real-time quota monitoring and account fleet switcher.');
    desc.style.margin = '2px 0 10px 0';

    const topGrid = element('div', 'agy-pool-top-grid');

    const cardStatus = element('div', 'agy-pool-card');
    const cardStatusTitle = element('div', 'agy-pool-card-title');
    cardStatusTitle.append(
      element('span', '', 'Switcher Status'),
      element('span', 'agy-pool-pill-status', '● Active')
    );

    const activeTier = pool.activeAccount ? poolQuotaCache.get(pool.activeAccount.id)?.quota?.planTier : undefined;
    const activeQuota = pool.activeAccount ? poolQuotaCache.get(pool.activeAccount.id)?.quota : undefined;
    const activeEmail = activeQuota?.email || pool.activeAccount?.email;
    const activeDisplay = activeEmail || pool.activeAccount?.label || pool.activeAccount?.id || 'None';
    const activeDisplayId = pool.activeAccount?.id
      ? (pool.activeAccount.id.length > 14 ? `${pool.activeAccount.id.slice(0, 8)}…${pool.activeAccount.id.slice(-4)}` : pool.activeAccount.id)
      : 'No ID';

    const activeBox = element('div', 'agy-switcher-active-box');
    const activeBoxLeft = element('div', 'agy-switcher-active-info');
    activeBoxLeft.append(
      element('div', 'agy-switcher-active-label', 'ACTIVE SERVING ACCOUNT'),
      element('div', 'agy-switcher-active-name', activeDisplay),
      element('div', 'agy-switcher-active-sub', `${activeDisplayId} · ${pool.poolStrategy || 'adaptive'}`)
    );
    activeBox.append(activeBoxLeft);

    if (activeTier) {
      const activeBoxRight = element('div', 'agy-switcher-active-right');
      const planBadge = element('span', 'agy-pool-plan-badge', activeTier);
      activeBoxRight.append(planBadge);
      activeBox.append(activeBoxRight);
    }

    const chipsRow = element('div', 'agy-switcher-chips-row');
    chipsRow.append(
      element('span', 'agy-pool-chip', `Pool Fleet: ${pool.accounts.length} Accounts`),
      element('span', 'agy-pool-chip', 'Failover: Auto-Rotate')
    );

    cardStatus.append(cardStatusTitle, activeBox, chipsRow);

    const cardQuota = element('div', 'agy-pool-card');
    const cardQuotaHeader = element('div', 'agy-pool-card-title', 'Active Account Quotas');

    const activeIsCustom = pool.activeAccount?.authMode !== 'antigravity';
    const activeQuotaData = pool.activeAccount ? poolQuotaCache.get(pool.activeAccount.id)?.quota : undefined;
    const activeParsed = parseQuotaBuckets(activeQuotaData, activeIsCustom);

    if (!activeParsed.hasBuckets) {
      const unmeteredMsg = element('div', 'agy-muted');
      unmeteredMsg.style.padding = '18px 8px';
      unmeteredMsg.style.textAlign = 'center';
      unmeteredMsg.textContent = activeIsCustom
        ? 'Custom GCP account active (no Cloud Code burst rate limits).'
        : 'Quota not metered on Cloud Code rate limit buckets.';
      cardQuota.append(cardQuotaHeader, unmeteredMsg);
    } else {
      const groupsRow = element('div', activeParsed.groups.length > 1 ? 'agy-pool-groups-row' : 'agy-pool-groups-container');
      for (const group of activeParsed.groups) {
        const groupCol = element('div', 'agy-pool-group-col');
        const groupHeader = element('div', 'agy-pool-group-header');
        groupHeader.append(element('span', 'agy-pool-group-title', group.displayName));

        if (group.unavailable) {
          const unavailBox = element('div', 'agy-pool-unavail-box');
          const unavailBadge = element('span', 'agy-pool-badge', group.notice || 'Unavailable on plan');
          unavailBadge.style.color = '#a1a1aa';
          unavailBadge.style.borderColor = 'rgba(255,255,255,0.15)';
          unavailBox.append(unavailBadge);
          groupCol.append(groupHeader, unavailBox);
        } else {
          const gaugesRow = element('div', 'agy-pool-gauges');
          const gaugeSize = 44;
          const strokeW = 4;
          const label5hText = activeParsed.groups.length > 1 ? '5-Hour' : '5-Hour Limit';
          const labelWkText = activeParsed.groups.length > 1 ? 'Weekly' : 'Weekly Limit';

          const gauge5h = element('div', 'agy-pool-gauge-item');
          gauge5h.append(
            renderCircleArc(group.fiveHour.fraction, gaugeSize, strokeW),
            element('div', 'agy-pool-gauge-label', label5hText),
            element('div', 'agy-pool-gauge-sub', formatResetHorizon(group.fiveHour.resetTime, group.fiveHour.fraction)),
          );

          const gaugeWk = element('div', 'agy-pool-gauge-item');
          gaugeWk.append(
            renderCircleArc(group.weekly.fraction, gaugeSize, strokeW),
            element('div', 'agy-pool-gauge-label', labelWkText),
            element('div', 'agy-pool-gauge-sub', formatResetHorizon(group.weekly.resetTime, group.weekly.fraction)),
          );

          gaugesRow.append(gauge5h, gaugeWk);
          groupCol.append(groupHeader, gaugesRow);
        }
        groupsRow.append(groupCol);
      }
      cardQuota.append(cardQuotaHeader, groupsRow);
    }

    topGrid.append(cardStatus, cardQuota);

    const fleetSection = element('div', 'agy-fleet-section');
    const fleetHeader = element('div', 'agy-fleet-header');
    fleetHeader.append(
      element('div', 'agy-pool-card-title', 'Account Fleet')
    );

    const table = element('table', 'agy-fleet-table');
    const colgroup = document.createElement('colgroup');
    const colAcc = document.createElement('col'); colAcc.style.width = '34%';
    const col5h = document.createElement('col'); col5h.style.width = '26%';
    const colWk = document.createElement('col'); colWk.style.width = '26%';
    const colAct = document.createElement('col'); colAct.style.width = '14%';
    colgroup.append(colAcc, col5h, colWk, colAct);
    table.append(colgroup);

    const thead = element('thead');
    const trHead = element('tr');
    trHead.append(
      element('th', '', 'Account'),
      element('th', '', '5-Hour Quota'),
      element('th', '', 'Weekly Quota'),
      element('th', '', 'Action')
    );
    thead.append(trHead);
    table.append(thead);

    const tbody = element('tbody');
    for (const account of pool.accounts) {
      const isActive = pool.activeAccount?.id === account.id;
      const tr = element('tr', isActive ? 'agy-fleet-row-active' : '');

      const isCustomAuth = account.authMode !== 'antigravity';
      const rowQuotaData = poolQuotaCache.get(account.id);
      const email = rowQuotaData?.quota?.email || account.email;
      const displayId = account.id && account.id.length > 14
        ? `${account.id.slice(0, 8)}…${account.id.slice(-4)}`
        : account.id;

      const tdAcc = element('td');
      const accInfo = element('div', 'agy-account-info');
      const primaryText = email || account.label || displayId;
      let secondaryText = displayId;
      if (email) {
        if (account.label && account.label !== email && account.label.toLowerCase() !== 'google account') {
          secondaryText = `${account.label} · ${displayId}`;
        }
      } else if (account.label && account.label !== displayId) {
        secondaryText = displayId;
      }

      const detectedPlan = rowQuotaData?.quota?.planTier;
      if (detectedPlan) {
        secondaryText = `${secondaryText} · ${detectedPlan}`;
      }

      const accTitle = `${email ? `${email}\n` : ''}${account.label && account.label !== email ? `Label: ${account.label}\n` : ''}ID: ${account.id}${account.project ? `\nProject: ${account.project}` : ''}${detectedPlan ? `\nPlan: ${detectedPlan}` : ''}`;
      accInfo.title = accTitle.trim();

      accInfo.append(
        element('span', 'agy-account-name', primaryText),
        element('span', 'agy-account-id', secondaryText)
      );
      tdAcc.append(accInfo);

      const rowParsed = parseQuotaBuckets(rowQuotaData?.quota, isCustomAuth);

      const td5h = element('td');
      if (!rowParsed.hasBuckets) {
        td5h.append(element('span', 'agy-muted', '— (N/A)'));
      } else {
        const subBars5h = element('div', 'agy-sub-bar-container');
        for (const group of rowParsed.groups) {
          const tag = group.isGemini ? 'Gemini' : (group.isThirdParty ? 'Claude/GPT' : group.name);
          const subBar = element('div', 'agy-sub-bar');
          const meta = element('div', 'agy-sub-bar-meta');

          if (group.unavailable) {
            meta.append(
              element('span', 'agy-sub-bar-tag', tag),
              element('span', 'agy-muted', 'Unavailable'),
            );
            subBar.append(meta);
          } else {
            const pct = Math.max(0, Math.min(100, Math.round(group.fiveHour.fraction * 100)));
            let color = '#34d399';
            if (pct < 20) color = '#f87171';
            else if (pct < 50) color = '#fbbf24';

            meta.append(
              element('span', 'agy-sub-bar-tag', tag),
              element('span', 'agy-bar-pct', `${pct}%`),
              element('span', 'agy-bar-sub', formatResetHorizon(group.fiveHour.resetTime, group.fiveHour.fraction)),
            );

            const track = element('div', 'agy-bar-track');
            const fill = element('div', 'agy-bar-fill');
            fill.style.width = `${pct}%`;
            fill.style.backgroundColor = color;
            track.append(fill);
            subBar.append(meta, track);
          }
          subBars5h.append(subBar);
        }
        td5h.append(subBars5h);
      }

      const tdWk = element('td');
      if (!rowParsed.hasBuckets) {
        tdWk.append(element('span', 'agy-pool-badge', 'PayG / GCP'));
      } else {
        const subBarsWk = element('div', 'agy-sub-bar-container');
        for (const group of rowParsed.groups) {
          const tag = group.isGemini ? 'Gemini' : (group.isThirdParty ? 'Claude/GPT' : group.name);
          const subBar = element('div', 'agy-sub-bar');
          const meta = element('div', 'agy-sub-bar-meta');

          if (group.unavailable) {
            meta.append(
              element('span', 'agy-sub-bar-tag', tag),
              element('span', 'agy-muted', 'Unavailable'),
            );
            subBar.append(meta);
          } else {
            const pct = Math.max(0, Math.min(100, Math.round(group.weekly.fraction * 100)));
            let color = '#34d399';
            if (pct < 20) color = '#f87171';
            else if (pct < 50) color = '#fbbf24';

            meta.append(
              element('span', 'agy-sub-bar-tag', tag),
              element('span', 'agy-bar-pct', `${pct}%`),
              element('span', 'agy-bar-sub', formatResetHorizon(group.weekly.resetTime, group.weekly.fraction)),
            );

            const track = element('div', 'agy-bar-track');
            const fill = element('div', 'agy-bar-fill');
            fill.style.width = `${pct}%`;
            fill.style.backgroundColor = color;
            track.append(fill);
            subBar.append(meta, track);
          }
          subBarsWk.append(subBar);
        }
        tdWk.append(subBarsWk);
      }

      const tdAct = element('td');
      tdAct.style.textAlign = 'right';
      if (isActive) {
        tdAct.append(element('span', 'agy-badge-active', '● Active'));
      } else {
        const isExhausted = isAccountQuotaExhausted(account.id, account.authMode);
        if (isExhausted) {
          const exBadge = element('span', 'agy-pool-badge', 'Exhausted');
          exBadge.style.color = '#f87171';
          exBadge.style.borderColor = 'rgba(248, 113, 113, 0.4)';
          exBadge.style.marginRight = '6px';
          tdAct.append(exBadge);
        }
        const switchBtn = button('⇄ Switch', async () => {
          switchBtn.disabled = true;
          switchBtn.textContent = 'Switching…';
          await switchPoolActiveAccount(account.id);
        });
        switchBtn.className = 'agy-btn agy-btn-switch';
        tdAct.append(switchBtn);
      }

      tr.append(tdAcc, td5h, tdWk, tdAct);
      tbody.append(tr);
    }
    table.append(tbody);
    fleetSection.append(fleetHeader, table);

    container.append(header, desc, topGrid, fleetSection);

    async function fetchAllQuotas(): Promise<void> {
      if (isRefreshingPoolQuotas) return;
      isRefreshingPoolQuotas = true;
      try {
        const tasks = pool.accounts.map(async (acc) => {
          try {
            const result = (await ipcRenderer.invoke('storage:google-test-account', {
              modelName: pool.modelName,
              accountId: acc.id,
            })) as { success?: boolean; quota?: any; error?: string; message?: string };
            if (result && result.success !== false && result.quota) {
              poolQuotaCache.set(acc.id, { quota: result.quota, timestamp: Date.now() });
              if (result.quota.email && !acc.email) {
                acc.email = result.quota.email;
              }
              if (result.quota.email && (!acc.label || acc.label.toLowerCase() === 'google account')) {
                acc.label = result.quota.email || result.quota.name || acc.label;
              }
            } else {
              poolQuotaCache.set(acc.id, {
                quota: undefined,
                error: result?.error || result?.message || 'Failed',
                timestamp: Date.now(),
              });
            }
          } catch (e: any) {
            poolQuotaCache.set(acc.id, { quota: undefined, error: e?.message || 'Error', timestamp: Date.now() });
          }
        });
        await Promise.allSettled(tasks);
      } finally {
        isRefreshingPoolQuotas = false;
      }
    }

    const anyStale = pool.accounts.some((a) => {
      const cached = poolQuotaCache.get(a.id);
      return !cached || Date.now() - cached.timestamp > 120_000;
    });

    if (anyStale && !isRefreshingPoolQuotas) {
      void fetchAllQuotas().then(() => {
        if (container.isConnected) void renderGooglePoolWidget(modelList);
      });
    }

    if (!poolWidgetInterval) {
      poolWidgetInterval = setInterval(() => {
        const c = document.getElementById('agy-google-account-pool-section');
        if (!c || !c.isConnected) {
          clearInterval(poolWidgetInterval);
          poolWidgetInterval = undefined;
          return;
        }
        const stale = pool.accounts.some((a) => {
          const cached = poolQuotaCache.get(a.id);
          return !cached || Date.now() - cached.timestamp > 120_000;
        });
        if (stale && !isRefreshingPoolQuotas) {
          void fetchAllQuotas().then(() => {
            if (c.isConnected) void renderGooglePoolWidget(modelList);
          });
        }
      }, 30_000);
    }
  }

  async function renderCustomModelsList(): Promise<void> {
    const target = document.getElementById('agy-custom-models-content');
    if (!target) return;
    const version = ++renderVersion;
    try {
      const models = await storageAPI.getCustomModels();
      if (version !== renderVersion || !target.isConnected) return;
      modelList = models;
      void renderGooglePoolWidget(models);
      target.replaceChildren();
      const groups = new Map<string, CustomModelEntry[]>();
      for (const model of models) {
        if (
          searchTerm &&
          !`${model.displayName} ${model.name} ${model.externalModelName} ${model.provider}`
            .toLowerCase()
            .includes(searchTerm)
        )
          continue;
        const key = `${model.provider}\n${model.apiUrl}`;
        groups.set(key, [...(groups.get(key) || []), model]);
      }
      if (!groups.size)
        target.append(
          element(
            'p',
            'agy-muted',
            models.length
              ? 'No models match this search.'
              : 'Add a provider model, discover a local server, or import a configuration to get started.',
          ),
        );
      for (const models of groups.values()) {
        const first = models[0];
        const group = element('section', 'agy-group');
        const header = element('div', 'agy-group-heading');
        const heading = element('div');
        heading.append(
          element(
            'h3',
            '',
            `${first.provider} · ${models.filter((model) => model.enabled !== false).length}/${models.length} enabled`,
          ),
          element('div', 'agy-muted', first.apiUrl),
        );
        const groupStatus = statusNode();
        const actions = element('div', 'agy-actions');
        actions.append(button('Discover models', () => openModelModal(first, 'discover'), groupStatus));
        const allEnabled = models.every((model) => model.enabled !== false);
        actions.append(
          button(
            allEnabled ? 'Disable group' : 'Enable group',
            async () => {
              for (const model of models)
                requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !allEnabled }));
              await modelsChanged();
            },
            groupStatus,
          ),
        );
        header.append(heading, actions);
        group.append(header, groupStatus);
        for (const model of models) {
          const row = element('div', 'agy-row');
          row.dataset.enabled = String(model.enabled !== false);
          const info = element('div', 'agy-row-info');
          info.append(
            element('strong', '', model.displayName || model.name),
            element('div', 'agy-muted', model.externalModelName),
          );
          if (model.nativePickerAvailable === false) info.append(element('div', 'agy-muted',
            typeof model.nativePickerError === 'string' ? model.nativePickerError :
              'Not currently available in the native model picker. Direct API access remains available.'));
          const rowStatus = statusNode();
          info.append(rowStatus);
          const actions = element('div', 'agy-actions');
          actions.append(
            button(
              model.enabled === false ? 'Enable' : 'Disable',
              async () => {
                requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: model.enabled === false }));
                await modelsChanged();
              },
              rowStatus,
            ),
            button(
              'Test',
              async () => {
                setStatus(rowStatus, 'Testing…');
                const result = requireSuccess(await storageAPI.testModelConnection(model));
                setStatus(rowStatus, result.message || 'Connection successful.');
              },
              rowStatus,
            ),
            button('Test generation', () => openGenerationTest(model), rowStatus),
            button('Edit', () => openModelModal(model, 'edit'), rowStatus),
            button('Duplicate', () => openModelModal(model, 'duplicate'), rowStatus),
            ...(model.supportsThinking === false
              ? []
              : [
                  button(
                    'Effort variants',
                    () => {
                      const { body, status, close } = openModal('Create reasoning variants');
                      body.append(
                        element(
                          'p',
                          'agy-muted',
                          'Creates three copies with low, medium and high reasoning effort. The provider must support reasoning. For Google and Anthropic formats the thinking budgets are 1,024 / 4,096 / 8,192 tokens; output limits increase if needed to fit the budget. Existing models and credentials are preserved.',
                        ),
                      );
                      body.append(
                        button(
                          'Create three variants',
                          async () => {
                            requireSuccess(await ipcRenderer.invoke('storage:create-effort-variants', model.name));
                            close();
                            await modelsChanged();
                          },
                          status,
                          true,
                        ),
                      );
                    },
                    rowStatus,
                  ),
                ]),
            button('Delete', () => openDeleteModelModal(model), rowStatus),
          );
          row.append(info, actions);
          group.append(row);
        }
        target.append(group);
      }
    } catch (error) {
      setStatus(target, error instanceof Error ? error.message : 'Could not load custom models.', true);
    }
  }

  async function openModelModal(
    existing?: CustomModelEntry,
    mode: 'edit' | 'duplicate' | 'discover' = 'edit',
  ): Promise<void> {
    const { body, status, close } = openModal(
      mode === 'duplicate'
        ? 'Duplicate model'
        : mode === 'discover'
          ? 'Discover provider models'
          : existing
            ? 'Edit model'
            : 'Add custom model',
    );
    try {
      const presets = await storageAPI.getPresets();
      if (!body.isConnected) return;
      const providers = [...presets];
      if (existing && !providers.some((preset) => preset.id === existing.provider))
        providers.push({
          id: existing.provider,
          label: existing.provider,
          defaultUrl: existing.apiUrl,
          apiFormat: existing.apiFormat || 'openai',
          keyRequired: false,
        });
      if (!providers.length) throw new Error('Provider presets are unavailable. Close this dialog and try again.');
      const provider = selectField(
        body,
        'Provider',
        'agy-provider',
        providers.map((preset) => [preset.id, preset.label]),
        existing?.provider || providers[0].id,
      );
      const preset = () => providers.find((value) => value.id === provider.value) || providers[0];
      const apiUrl = field(body, 'API URL', 'agy-api-url', existing?.apiUrl || preset().defaultUrl, 'url');
      const workersHint = element(
        'p',
        'agy-muted',
        'Cloudflare: replace ACCOUNT_ID in the API URL with your 32-character Account ID. Use the Workers AI API token template, or keep your existing authentication headers. Model discovery verifies catalog access; generation is not tested.',
      );
      body.append(workersHint);
      function workersConnection(): boolean {
        if (provider.value === 'workers-ai') return true;
        try {
          const url = new URL(apiUrl.value);
          return url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\//.test(url.pathname);
        } catch {
          return false;
        }
      }
      const updateWorkersHint = () => {
        workersHint.hidden = !workersConnection();
      };
      apiUrl.addEventListener('input', updateWorkersHint);
      updateWorkersHint();
      const apiKey = field(
        body,
        'API key',
        'agy-api-key',
        existing?.apiKey === 'none' ? '' : existing?.apiKey || '',
        'password',
      );
      apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
      const apiFormat = selectField(
        body,
        'API format',
        'agy-api-format',
        [
          ['openai', 'OpenAI compatible'],
          ['anthropic', 'Anthropic Messages'],
          ['google', 'Google Gemini'],
        ],
        existing?.apiFormat || preset().apiFormat,
      );
      const grid = element('div', 'agy-grid');
      const modelId = field(
        grid,
        'Provider model ID',
        'agy-model-id',
        mode === 'discover' ? '' : existing?.externalModelName || '',
      );
      const displayName = field(
        grid,
        'Display name',
        'agy-display-name',
        mode === 'duplicate'
          ? `${existing?.displayName || existing?.externalModelName || ''} copy`
          : mode === 'discover'
            ? ''
            : existing?.displayName || '',
      );
      body.append(grid);
      const name = field(
        body,
        'Configuration name (unique)',
        'agy-model-name',
        mode === 'duplicate' ? uniqueName(`${existing?.name}-copy`) : mode === 'discover' ? '' : existing?.name || '',
      );
      name.placeholder = 'Generated from provider and model ID when left blank';
      const description = field(body, 'Description', 'agy-description', String(existing?.description || ''));
      const googleConfig = element('div');
      googleConfig.id = 'agy-google-account-config';
      const googleProject = field(
        googleConfig,
        'Default Cloud Code project (optional)',
        'agy-google-project',
        String(existing?.googleProject || ''),
      );
      const initialPool = existing?.googlePool as
        | { strategy?: string; maxConcurrency?: number; cooldownMs?: number }
        | undefined;
      const poolGrid = element('div', 'agy-grid');
      const poolStrategy = selectField(
        poolGrid,
        'Account selection',
        'agy-google-pool-strategy',
        [
          ['round-robin', 'Round robin'],
          ['least-loaded', 'Least loaded'],
          ['quota', 'Remaining quota'],
          ['adaptive', 'Adaptive health and load'],
        ],
        initialPool?.strategy || 'least-loaded',
      );
      const poolConcurrency = field(
        poolGrid,
        'Maximum requests per account',
        'agy-google-pool-concurrency',
        String(initialPool?.maxConcurrency || 2),
        'number',
      );
      const poolCooldown = field(
        poolGrid,
        'Account cooldown (milliseconds)',
        'agy-google-pool-cooldown',
        String(initialPool?.cooldownMs || 60000),
        'number',
      );
      googleConfig.append(poolGrid);
      const readAccounts = createGoogleAccountPanel(
        googleConfig,
        Array.isArray(existing?.googleAccounts) ? (existing.googleAccounts as GoogleAccountEntry[]) : [],
        existing?.name,
      );
      const updateGoogleVisibility = () => {
        const isGoogle = provider.value === 'google-cloudcode';
        googleConfig.hidden = !isGoogle;
        apiFormat.closest('label')!.hidden = isGoogle;
        apiKey.closest('label')!.hidden = isGoogle;
      };
      updateGoogleVisibility();
      body.append(googleConfig);
      const advanced = element('details');
      advanced.append(element('summary', '', 'Advanced settings'));
      const advancedGrid = element('div', 'agy-grid');
      const effort = selectField(
        advancedGrid,
        'Reasoning effort',
        'agy-reasoning-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => [
          value,
          value || 'Provider default',
        ]),
        String(existing?.reasoningEffort || ''),
      );
      const thinking = field(
        advancedGrid,
        'Thinking budget (tokens)',
        'agy-thinking-budget',
        existing?.thinkingBudget != null ? String(existing.thinkingBudget) : '',
        'number',
      );
      const compactionEffort = selectField(
        advancedGrid,
        'Compaction reasoning effort',
        'agy-compaction-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => [
          value,
          value || 'Use normal model settings',
        ]),
        String(existing?.compactionReasoningEffort || ''),
      );
      advancedGrid.append(
        element(
          'p',
          'agy-muted',
          'Only recognized IDE continuation summaries use this effort. Choose low for faster summaries, or none if your model supports disabling reasoning. Normal chat keeps its settings.',
        ),
      );
      const maxOutput = field(
        advancedGrid,
        'Maximum output tokens',
        'agy-max-output',
        existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '',
        'number',
      );
      const context = field(
        advancedGrid,
        'Context window (tokens)',
        'agy-context-window',
        existing?.contextWindow != null ? String(existing.contextWindow) : '',
        'number',
      );
      const compactionThreshold = field(
        advancedGrid,
        'IDE compaction threshold (%)',
        'agy-compaction-threshold',
        existing?.compactionThresholdPercent != null ? String(existing.compactionThresholdPercent) : '',
        'number',
      );
      compactionThreshold.min = '10';
      compactionThreshold.max = '90';
      compactionThreshold.placeholder = 'IDE default';
      advancedGrid.append(element('p', 'agy-muted',
        'Optional, 10–90% of the actual context window in new tokens since the previous checkpoint. Native counts may differ from provider totals. With many tools, start at 50%; higher values can trim older history before a full checkpoint. Leave blank for IDE defaults. The threshold is capped to reserve the model output limit plus 1,024 tokens. Set accurate context and output limits, then fully quit and reopen the IDE; the model cache may take an additional turn to refresh.',
      ));
      advancedGrid.append(element('p', 'agy-muted',
        'IDE 2.5.5 needs at least 50,000 input tokens after those reserves. Its native picker may show a compatibility context, for example 90,000 for a real 85,000-token model. Your saved context and provider limit remain 85,000 in that example, and the custom checkpoint policy uses that real limit.',
      ));
      const timeout = field(
        advancedGrid,
        'Request timeout (milliseconds)',
        'agy-timeout',
        existing?.timeout != null ? String(existing.timeout) : '',
        'number',
      );
      const retries = field(
        advancedGrid,
        'Maximum retries (0–5)',
        'agy-max-retries',
        existing?.maxRetries != null ? String(existing.maxRetries) : '',
        'number',
      );
      retries.max = '5';
      const vision = selectField(
        advancedGrid,
        'Image input',
        'agy-vision',
        [
          ['', 'Auto detect'],
          ['true', 'Supported'],
          ['false', 'Unsupported'],
        ],
        existing?.supportsVision == null ? '' : String(existing.supportsVision),
      );
      const rawUrl = selectField(
        advancedGrid,
        'Endpoint path',
        'agy-raw-url',
        [
          ['false', 'Normalize for provider'],
          ['true', 'Use exactly as entered'],
        ],
        String(existing?.rawUrl === true),
      );
      const tls = selectField(
        advancedGrid,
        'TLS certificates',
        'agy-tls',
        [
          ['false', 'Verify certificates'],
          ['true', 'Allow self-signed certificates'],
        ],
        String(existing?.allowUnauthorized === true),
      );
      const enabled = selectField(
        advancedGrid,
        'Model state',
        'agy-enabled',
        [
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        String(existing?.enabled !== false),
      );
      advanced.append(advancedGrid);
      const fallbacks = field(
        advanced,
        'Fallback model configuration names (comma separated)',
        'agy-fallback-models',
        Array.isArray(existing?.fallbackModels) ? existing.fallbackModels.join(', ') : '',
      );
      const headers = jsonField(advanced, 'Custom headers (JSON)', 'agy-custom-headers', existing?.customHeaders);
      const extraBody = jsonField(advanced, 'Additional request fields (JSON)', 'agy-extra-body', existing?.extraBody);
      const breaker = existing?.circuitBreaker as
        | { enabled?: boolean; failureThreshold?: number; cooldownMs?: number }
        | undefined;
      const breakerGrid = element('div', 'agy-grid');
      const breakerEnabled = selectField(
        breakerGrid,
        'Circuit breaker',
        'agy-breaker-enabled',
        [
          ['', 'Default'],
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        breaker?.enabled == null ? '' : String(breaker.enabled),
      );
      const breakerThreshold = field(
        breakerGrid,
        'Failures before cooldown',
        'agy-breaker-threshold',
        breaker?.failureThreshold != null ? String(breaker.failureThreshold) : '',
        'number',
      );
      const breakerCooldown = field(
        breakerGrid,
        'Cooldown (milliseconds)',
        'agy-breaker-cooldown',
        breaker?.cooldownMs != null ? String(breaker.cooldownMs) : '',
        'number',
      );
      advanced.append(breakerGrid);
      body.append(advanced);
      const discovery = element('div', 'agy-discovery');
      const discoveryFilter = element('div');
      discoveryFilter.hidden = true;
      const discoverySearch = field(discoveryFilter, 'Search provider models', 'agy-discovery-search', '', 'search');
      discoverySearch.placeholder = 'Filter by model name or ID';
      discoverySearch.addEventListener('input', () => showChoices());
      let choices: ModelChoice[] = [];
      const selected = new Set<string>();
      function hasWorkersAuthentication(customHeaders?: Record<string, unknown>): boolean {
        const authentication = Object.fromEntries(
          Object.entries(customHeaders || {}).map(([key, value]) => [
            key.toLowerCase(),
            typeof value === 'string' ? value.trim() : '',
          ]),
        );
        return !!(
          (apiKey.value.trim() && apiKey.value.trim() !== 'none') ||
          authentication.authorization ||
          (authentication['x-auth-key'] && authentication['x-auth-email'])
        );
      }
      function connection(): Partial<CustomModelEntry> {
        const endpoint = validUrl(apiUrl.value);
        const customHeaders = readJson(headers, 'Custom headers');
        if (workersConnection()) {
          if (
            !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(
              new URL(endpoint).pathname,
            )
          )
            throw new Error('Replace ACCOUNT_ID in the Cloudflare API URL with your 32-character Account ID.');
          if (apiFormat.value !== 'openai')
            throw new Error('Cloudflare Workers AI requires the OpenAI compatible API format.');
          if (!hasWorkersAuthentication(customHeaders))
            throw new Error('Enter a Cloudflare Workers AI API token or authentication headers.');
        }
        return {
          provider: provider.value,
          apiUrl: endpoint,
          apiKey: apiKey.value.trim() || 'none',
          apiFormat: apiFormat.value,
          name: existing?.name,
          allowUnauthorized: tls.value === 'true',
          externalModelName: modelId.value.trim(),
          customHeaders,
          rawUrl: rawUrl.value === 'true',
          ...(provider.value === 'google-cloudcode'
            ? {
                googleAccounts: readAccounts(),
                googleProject: googleProject.value.trim(),
                googlePool: {
                  strategy: poolStrategy.value,
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                },
              }
            : {}),
        };
      }
      function modelConfig(id: string, title: string, localName?: string): CustomModelEntry {
        if (!id.trim() || /\s/.test(id.trim())) throw new Error('Enter a model ID without spaces.');
        if (preset().keyRequired && !apiKey.value.trim() && !workersConnection())
          throw new Error('Enter an API key for this provider.');
        if (provider.value === 'google-cloudcode' && !readAccounts().some((account) => account.enabled !== false))
          throw new Error('Add and enable at least one Google account.');
        const maxRetries = readNumber(retries, 'Maximum retries');
        if (maxRetries != null && maxRetries > 5) throw new Error('Maximum retries cannot exceed 5.');
        const compactionThresholdPercent = readNumber(compactionThreshold, 'IDE compaction threshold', 10);
        if (compactionThresholdPercent != null && compactionThresholdPercent > 90)
          throw new Error('IDE compaction threshold cannot exceed 90%.');
        if (compactionThresholdPercent != null && !context.value.trim())
          throw new Error('Set the actual context window before configuring the IDE compaction threshold.');
        const customHeaders = readJson(headers, 'Custom headers');
        if (customHeaders && Object.values(customHeaders).some((value) => typeof value !== 'string'))
          throw new Error('Custom header values must be strings.');
        return {
          ...(mode === 'edit' && existing ? existing : {}),
          ...connection(),
          name: localName || name.value.trim() || uniqueName(`models/${provider.value}/${id}`),
          provider: provider.value,
          apiUrl: apiUrl.value.trim(),
          apiKey: apiKey.value.trim() || 'none',
          externalModelName: id.trim(),
          displayName: title || id.trim(),
          description: description.value.trim(),
          enabled: enabled.value === 'true',
          apiFormat: apiFormat.value,
          googleAccounts: provider.value === 'google-cloudcode' ? readAccounts() : undefined,
          googleProject: provider.value === 'google-cloudcode' ? googleProject.value.trim() || undefined : undefined,
          googlePool:
            provider.value === 'google-cloudcode'
              ? {
                  strategy: poolStrategy.value,
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                }
              : undefined,
          reasoningEffort: effort.value || undefined,
          compactionReasoningEffort: compactionEffort.value || undefined,
          compactionThresholdPercent,
          thinkingBudget: readNumber(thinking, 'Thinking budget'),
          maxOutputTokens: readNumber(maxOutput, 'Maximum output tokens', 1),
          contextWindow: readNumber(context, 'Context window', 1),
          timeout: readNumber(timeout, 'Timeout', 1),
          maxRetries,
          fallbackModels: fallbacks.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          customHeaders,
          extraBody: readJson(extraBody, 'Additional request fields'),
          supportsVision: vision.value === '' ? undefined : vision.value === 'true',
          rawUrl: rawUrl.value === 'true',
          allowUnauthorized: tls.value === 'true',
          circuitBreaker:
            breakerEnabled.value || breakerThreshold.value || breakerCooldown.value
              ? {
                  enabled: breakerEnabled.value !== 'false',
                  failureThreshold: readNumber(breakerThreshold, 'Failure threshold', 1),
                  cooldownMs: readNumber(breakerCooldown, 'Cooldown', 1),
                }
              : undefined,
          ...(existing?.name && mode === 'edit'
            ? { originalName: existing.name }
            : existing?.name
              ? { copyFrom: existing.name }
              : {}),
        };
      }
      function showChoices(): void {
        discovery.replaceChildren();
        discoveryFilter.hidden = !choices.length;
        if (!choices.length) return;
        const query = discoverySearch.value.trim().toLowerCase();
        const visible = choices.filter((model) =>
          `${model.displayName || ''} ${model.id}`.toLowerCase().includes(query),
        );
        const toolbar = element('div', 'agy-actions');
        const count = element(
          'span',
          'agy-muted',
          `${visible.length} of ${choices.length} models · ${selected.size} selected`,
        );
        toolbar.append(
          count,
          button(
            query ? 'Select filtered' : 'Select all',
            () => {
              for (const model of visible) selected.add(model.id);
              showChoices();
            },
            status,
          ),
          button(
            'Clear selection',
            () => {
              selected.clear();
              showChoices();
            },
            status,
          ),
        );
        discovery.append(toolbar);
        if (!visible.length) discovery.append(element('p', 'agy-muted', 'No provider models match this search.'));
        for (const model of visible) {
          const label = element('label', 'agy-choice');
          const checkbox = element('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selected.has(model.id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(model.id);
            else selected.delete(model.id);
            count.textContent = `${visible.length} of ${choices.length} models · ${selected.size} selected`;
          });
          label.append(
            checkbox,
            element(
              'span',
              '',
              model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id,
            ),
          );
          discovery.append(label);
        }
      }
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Test connection',
          async () => {
            setStatus(status, 'Testing…');
            const result = requireSuccess(await storageAPI.testModelConnection(connection()));
            setStatus(status, result.message || 'Connection successful.');
          },
          status,
        ),
        button(
          'Test generation (may incur charges)',
          async () => {
            setStatus(status, 'Sending a short generation test…');
            const result = requireSuccess(await storageAPI.testModelGeneration(connection()));
            setStatus(status, result.message || 'Generation succeeded.');
          },
          status,
        ),
        button(
          'Fetch provider models',
          async () => {
            setStatus(status, 'Fetching models…');
            const result = await storageAPI.discoverModels(connection());
            requireSuccess(result);
            choices = result.models || [];
            discoverySearch.value = '';
            selected.clear();
            showChoices();
            setStatus(
              status,
              choices.length
                ? 'Select models below, then choose Add selected.'
                : 'This provider returned no models. You can enter a model ID manually.',
            );
          },
          status,
        ),
        button(
          'Save model',
          async () => {
            requireSuccess(await storageAPI.saveCustomModel(modelConfig(modelId.value, displayName.value.trim())));
            await modelsChanged();
            close();
          },
          status,
          true,
        ),
      );
      body.append(actions, discoveryFilter, discovery);
      body.append(
        button(
          'Add selected',
          async () => {
            if (!selected.size) throw new Error('Select at least one model from the fetched list.');
            let saved = 0;
            for (const choice of choices.filter((model) => selected.has(model.id))) {
              const prior = modelList.find(
                (model) =>
                  model.provider === provider.value &&
                  model.apiUrl === apiUrl.value.trim() &&
                  model.externalModelName === choice.id,
              );
              const config = modelConfig(
                choice.id,
                choice.displayName || choice.id,
                prior?.name || uniqueName(`models/${provider.value}/${choice.id}`),
              );
              // Prefer explicit form overrides; otherwise retain the catalog's advertised limits/capabilities.
              for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking'] as const) {
                if (config[key] === undefined && choice[key] !== undefined) config[key] = choice[key];
              }
              if (
                typeof config.contextWindow === 'number' &&
                typeof config.maxOutputTokens === 'number' &&
                config.maxOutputTokens >= config.contextWindow &&
                !maxOutput.value.trim()
              ) {
                config.maxOutputTokens = config.contextWindow > 1 ? config.contextWindow - 1 : undefined;
              }
              delete config.originalName;
              if (prior) config.originalName = prior.name;
              else if (existing?.name) config.copyFrom = existing.name;
              requireSuccess(await storageAPI.saveCustomModel(config));
              saved++;
            }
            await modelsChanged();
            setStatus(status, `Saved ${saved} models.`);
          },
          status,
        ),
      );
      provider.addEventListener('change', () => {
        apiUrl.value = preset().defaultUrl;
        apiFormat.value = preset().apiFormat;
        apiKey.value = '';
        apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
        updateWorkersHint();
        choices = [];
        selected.clear();
        discoverySearch.value = '';
        showChoices();
        updateGoogleVisibility();
      });
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : 'Could not open model settings.', true);
    }
  }

  async function openImportExport(kind: 'import' | 'export'): Promise<void> {
    const { body, status } = openModal(kind === 'export' ? 'Export models' : 'Import models');
    body.append(
      element(
        'p',
        'agy-muted',
        kind === 'export'
          ? 'Credentials are removed from this export. Add API keys on the destination device.'
          : 'Paste a model configuration as JSON or an exported base64 string. Existing configurations are merged by name.',
      ),
    );
    const input = jsonField(body, 'Configuration', 'agy-config-json', undefined);
    input.rows = 14;
    if (kind === 'export') {
      input.readOnly = true;
      try {
        input.value = JSON.stringify(await ipcRenderer.invoke('storage:export-custom-models'), null, 2);
      } catch (error) {
        setStatus(status, String(error), true);
      }
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Select all',
          () => {
            input.focus();
            input.select();
          },
          status,
        ),
        button(
          'Copy JSON',
          async () => {
            await navigator.clipboard.writeText(input.value);
            setStatus(status, 'Configuration copied.');
          },
          status,
        ),
      );
      body.append(actions);
    } else {
      const file = field(body, 'Or choose a JSON file', 'agy-import-file', '', 'file');
      file.accept = '.json,application/json';
      file.addEventListener('change', async () => {
        try {
          const selected = file.files?.[0];
          if (!selected) return;
          if (selected.size > 2 * 1024 * 1024) throw new Error('Configuration files must be smaller than 2 MB.');
          input.value = await selected.text();
        } catch (error) {
          setStatus(status, String(error), true);
        }
      });
      body.append(
        button(
          'Import configuration',
          async () => {
            if (!input.value.trim()) throw new Error('Paste a configuration or choose a file first.');
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-custom-models', input.value.trim()));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} models. Add any missing API keys before use.`);
          },
          status,
          true,
        ),
      );
    }
  }
  async function discoverLocal(): Promise<void> {
    const { body, status } = openModal('Local model servers');
    setStatus(status, 'Checking Ollama, LM Studio and llama.cpp on this computer…');
    try {
      const result = (await ipcRenderer.invoke('storage:discover-local')) as ActionResult & {
        servers?: { provider: string; apiUrl: string; models: ModelChoice[] }[];
      };
      requireSuccess(result);
      if (!body.isConnected) return;
      setStatus(
        status,
        result.servers?.length
          ? 'Choose a server to configure its models.'
          : 'No local model servers were found. Start a server or add its URL manually.',
      );
      for (const server of result.servers || []) {
        const row = element('div', 'agy-row');
        row.append(
          element('span', '', `${server.provider} · ${server.models.length} models`),
          element('div', 'agy-muted', server.apiUrl),
          button(
            'Configure',
            () =>
              openModelModal(
                { name: '', provider: server.provider, apiUrl: server.apiUrl, apiKey: 'none', externalModelName: '' },
                'discover',
              ),
            status,
          ),
        );
        body.append(row);
      }
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function openGenerationTest(model: CustomModelEntry): void {
    const { body, status } = openModal('Test model generation');
    body.append(element('p', '', `Model: ${model.displayName || model.externalModelName || model.name}`));
    body.append(
      element(
        'p',
        'agy-muted',
        'Sends one “Reply with OK.” request with a 32-token output limit using this model’s saved settings. Your provider may charge for the request. No conversation content is sent.',
      ),
    );
    body.append(
      button(
        'Run generation test',
        async () => {
          setStatus(status, 'Sending a short generation test…');
          const result = requireSuccess(await storageAPI.testModelGeneration(model));
          setStatus(status, result.message || 'Generation succeeded.');
        },
        status,
        true,
      ),
    );
  }

  async function openDiagnostics(): Promise<void> {
    const { body, status } = openModal('Proxy diagnostics');
    body.append(
      element(
        'p',
        'agy-muted',
        'Measured requests from this proxy process only; restarting clears the history. Up to 200 completed requests are retained. Prompts, responses, URLs and credentials are not recorded. Gateway requests have separate history in its dashboard.',
      ),
    );
    const summary = element('div');
    summary.id = 'agy-diagnostics-summary';
    const search = field(body, 'Filter by model or provider', 'agy-diagnostics-search');
    const recent = element('div');
    const list = element('div');
    list.id = 'agy-diagnostics-requests';
    const output = element('textarea');
    output.id = 'agy-diagnostics-export';
    output.readOnly = true;
    output.rows = 8;
    output.hidden = true;
    output.setAttribute('aria-label', 'Exported diagnostic metadata');
    let snapshot: DiagnosticsSnapshot | undefined;
    const token = (value: unknown) => (typeof value === 'number' ? value.toLocaleString() : 'unknown');
    const render = () => {
      if (!snapshot) return;
      const s = snapshot.summary;
      summary.replaceChildren(
        element(
          'p',
          '',
          `${s.requests} completed · ${snapshot.active} active · ${s.succeeded} succeeded · ${s.failed} failed · ${s.cancelled} cancelled`,
        ),
      );
      summary.append(
        element(
          'p',
          'agy-muted',
          s.measuredRequests
            ? `Provider-reported tokens: ${token(s.measuredInputRequests ? s.inputTokens : undefined)} input · ${token(s.measuredOutputRequests ? s.outputTokens : undefined)} output · ${token(s.measuredCachedRequests ? s.cachedTokens : undefined)} cached. Usage received for ${s.measuredRequests} of ${s.requests} requests; totals exclude unknown usage.`
            : 'Token usage: unknown. No provider-reported usage received yet.',
        ),
      );
      recent.replaceChildren();
      if (snapshot.recentModels.length)
        recent.append(element('p', 'agy-muted', `Recently used: ${snapshot.recentModels.join(' · ')}`));
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const rows = snapshot.requests.filter((r) => `${r.model} ${r.provider}`.toLowerCase().includes(query));
      if (!rows.length) list.append(element('p', 'agy-muted', 'No matching requests recorded.'));
      for (const r of rows) {
        const row = element('div', 'agy-row');
        row.append(element('strong', '', `${r.model} · ${r.provider}`));
        row.append(
          element(
            'div',
            'agy-muted',
            `${new Date(r.timestamp).toLocaleTimeString()} · ${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.latencyMs} ms · ${r.kind === 'generation-test' ? 'generation test' : r.stream ? 'streaming' : 'request'}`,
          ),
        );
        row.append(
          element(
            'div',
            'agy-muted',
            `Tokens: ${token(r.inputTokens)} input · ${token(r.outputTokens)} output · ${token(r.cachedTokens)} cached`,
          ),
        );
        list.append(row);
      }
    };
    const refresh = async () => {
      snapshot = await ipcRenderer.invoke('storage:get-diagnostics');
      requireSuccess(snapshot);
      if (body.isConnected) render();
    };
    search.addEventListener('input', render);
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Refresh diagnostics', refresh, status),
      button(
        'Export diagnostics',
        () => {
          output.value = JSON.stringify(snapshot, null, 2);
          output.hidden = false;
          output.focus();
          output.select();
        },
        status,
      ),
      button(
        'Clear diagnostic history',
        async () => {
          requireSuccess(await ipcRenderer.invoke('storage:clear-diagnostics'));
          output.value = '';
          output.hidden = true;
          await refresh();
        },
        status,
      ),
    );
    body.append(summary, recent, actions, output, list);
    await refresh();
  }

  async function openGateway(): Promise<void> {
    const { body, status } = openModal('Remote gateway');
    try {
      const saved = (await ipcRenderer.invoke('storage:get-gateway')) as GatewayConfig;
      if (!body.isConnected) return;
      body.append(
        element(
          'p',
          'agy-muted',
          'Connect to your proxy gateway to import its model aliases and open its management dashboard.',
        ),
      );
      const url = field(body, 'Gateway URL', 'agy-gateway-url', saved?.url || '', 'url');
      const token = field(body, 'Gateway token', 'agy-gateway-token', saved?.token || '', 'password');
      const dashboard = field(body, 'Dashboard URL (optional)', 'agy-dashboard-url', saved?.dashboardUrl || '', 'url');
      const config = (): GatewayConfig => ({
        url: validUrl(url.value),
        token: token.value.trim(),
        dashboardUrl: dashboard.value.trim() ? validUrl(dashboard.value) : '',
      });
      const save = async () => {
        requireSuccess(await ipcRenderer.invoke('storage:save-gateway', config()));
      };
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Save connection',
          async () => {
            await save();
            setStatus(status, 'Gateway connection saved.');
          },
          status,
          true,
        ),
        button(
          'Test gateway',
          async () => {
            setStatus(status, 'Connecting…');
            const result = requireSuccess(await ipcRenderer.invoke('storage:test-gateway', config()));
            setStatus(status, result.message || 'Gateway reachable and authentication accepted.');
          },
          status,
        ),
        button(
          'Import model aliases',
          async () => {
            await save();
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-gateway-models'));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} gateway models.`);
          },
          status,
        ),
        button(
          'Open dashboard',
          async () => {
            await save();
            requireSuccess(await ipcRenderer.invoke('storage:open-gateway-dashboard'));
          },
          status,
        ),
      );
      body.append(actions);
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function findSettingsMount(): HTMLElement | null {
    // Desktop settings are a modal over /c/...; older layouts use a settings route.
    // A chat span saying "MCP" is not evidence that the settings page is open.
    const settingsRoot = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-label="Settings"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"]',
      ),
    ).find(isSettingsContent);
    const settingsRoute =
      /^\/settings(?:\/|$)/i.test(window.location.pathname) || /^#\/?settings(?:\/|\?|$)/i.test(window.location.hash);
    const root = settingsRoot || (settingsRoute ? document.body : null);
    if (!root) return null;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,[role="heading"],div,span'));
    const heading = headings.find(
      (node) =>
        node.children.length === 0 &&
        /^(Models\s*(?:&|and)\s*Usage|Model Settings|MCP Servers|MCP)$/i.test(node.textContent?.trim() || '') &&
        isSettingsContent(node),
    );
    if (heading) {
      const section = heading.closest('section');
      if (section && root.contains(section)) return section;
      const panel = heading.closest('[role="tabpanel"]');
      if (panel && root.contains(panel)) return panel as HTMLElement;
      let content: HTMLElement = heading;
      while (content.parentElement && content.parentElement !== root) {
        if (content.parentElement.classList.contains('overflow-y-auto')) return content;
        content = content.parentElement;
      }
      const fallback = heading.parentElement?.parentElement || heading.parentElement;
      return fallback && root.contains(fallback) ? fallback : root;
    }
    const refresh = findRefreshButton(root);
    const legacy = refresh?.parentElement?.parentElement?.parentElement;
    if (
      legacy &&
      root.contains(legacy) &&
      isSettingsContent(legacy) &&
      /MCP|Model Context Protocol/i.test(legacy.textContent || '')
    )
      return legacy;
    return null;
  }
  function injectCustomModelsSection(): void {
    const mount = findSettingsMount();
    const existing = document.getElementById('agy-custom-models-section');
    const existingPool = document.getElementById('agy-google-account-pool-section');
    if (existing && existingPool && mount && existing.parentElement === mount && existingPool.parentElement === mount) return;
    existing?.remove();
    existingPool?.remove();
    if (!mount) return;
    installStyles();
    const poolSection = element('section');
    poolSection.id = 'agy-google-account-pool-section';
    poolSection.setAttribute('aria-label', 'Google Account Fleet & Quota Overview');
    poolSection.hidden = true;
    const section = element('section');
    section.id = 'agy-custom-models-section';
    section.setAttribute('aria-label', 'Custom Models');
    const header = element('div', 'agy-toolbar');
    const addModel = button('Add model', () => openModelModal(), undefined, true);
    addModel.id = 'agy-add-model';
    header.append(element('h2', '', 'Custom Models'), addModel);
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Discover local', discoverLocal),
      button('Import', () => openImportExport('import')),
      button('Export', () => openImportExport('export')),
      button('Remote gateway', openGateway),
      button('Diagnostics', openDiagnostics),
    );
    const search = field(section, 'Search models', 'agy-model-search', searchTerm, 'search');
    search.placeholder = 'Search by name, model ID or provider';
    search.addEventListener('input', () => {
      searchTerm = search.value.trim().toLowerCase();
      void renderCustomModelsList();
    });
    const content = element('div');
    content.id = 'agy-custom-models-content';
    const status = statusNode();
    status.id = 'agy-main-status';
    section.prepend(
      header,
      element('p', 'agy-muted', 'Provider connections, local models and remote gateways.'),
      actions,
    );
    section.append(status, content);
    mount.append(poolSection, section);
    void renderCustomModelsList();
  }
  function isDropdownVisible(el: HTMLElement): boolean {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    if (el.getAttribute('data-state') === 'closed') return false;
    return true;
  }

  let activeModelMenu: HTMLElement | null = null;

  function findModelPickerDropdown(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menu"], [role="listbox"], [data-radix-menu-content]',
      ),
    );

    for (const el of candidates) {
      if (!el || el.id === 'agy-modal-overlay' || el.closest('#agy-modal-overlay') || el.closest('#agy-custom-models-section')) continue;
      if (!isDropdownVisible(el)) continue;

      // Strictly reject submenus (such as View Usage sub-flyout or effort sub-flyout)
      if (
        el.hasAttribute('data-radix-menu-sub-content') ||
        el.hasAttribute('data-radix-dropdown-menu-sub-content') ||
        el.matches?.('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]')
      ) continue;
      if (el.parentElement?.closest('[role="menu"], [data-radix-menu-content]')) continue;

      // Reject submenus linked to trigger menuitems (like View Usage or effort trigger)
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const trigger = document.getElementById(labelledBy);
        if (trigger) {
          if (trigger.getAttribute('role') === 'menuitem' || trigger.closest('[role="menu"], [data-radix-menu-content]')) {
            continue;
          }
          if (/usage/i.test(trigger.textContent || '')) {
            continue;
          }
        }
      }

      if (el.id) {
        const trigger = document.querySelector(`[aria-controls="${el.id}"]`);
        if (trigger) {
          if (trigger.getAttribute('role') === 'menuitem' || trigger.closest('[role="menu"], [data-radix-menu-content]')) {
            continue;
          }
          if (/usage/i.test(trigger.textContent || '')) {
            continue;
          }
        }
      }

      const rect = el.getBoundingClientRect?.() || { width: el.offsetWidth || 0, height: el.offsetHeight || 0 };
      if (rect.width > 0 && (rect.width < 140 || rect.width > 480)) continue;
      if (rect.height > 0 && rect.height < 60) continue;

      // Reject usage & quota panels/submenus
      const rawText = el.textContent || '';
      if (/\b(?:resets?\s+in|quota|requests?\s+remaining|token\s+usage|spend|billing)\b/i.test(rawText)) {
        continue;
      }

      const leaves = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((c) => c.children.length === 0);
      const textLeaves = leaves.map((c) => c.textContent?.trim() || '').filter(Boolean);
      if (textLeaves.length === 0) continue;

      // The top header must strictly be 'Model'
      const modelIndex = textLeaves.findIndex((t) => t === 'Model');
      if (modelIndex === -1 || modelIndex > 1) continue;

      // Must contain 'View Usage' action row separated from the Model header by model entries
      const viewUsageIndex = textLeaves.findIndex((t) => /^View\s+Usage$/i.test(t));
      if (viewUsageIndex === -1 || viewUsageIndex <= modelIndex + 1) continue;

      return el;
    }
    return null;
  }

  function attachModelPickerSearch(menu: HTMLElement): void {
    if (menu.dataset.agySearchInjected === 'true') return;
    if (menu.querySelector('.agy-model-search-box')) return;

    // Safety guard: Never attach to any submenu or usage view
    if (
      menu.hasAttribute('data-radix-menu-sub-content') ||
      menu.hasAttribute('data-radix-dropdown-menu-sub-content') ||
      menu.matches?.('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]') ||
      menu.parentElement?.closest('[role="menu"], [data-radix-menu-content]')
    ) return;

    const labelledBy = menu.getAttribute('aria-labelledby');
    if (labelledBy) {
      const trigger = document.getElementById(labelledBy);
      if (trigger && (trigger.getAttribute('role') === 'menuitem' || /usage/i.test(trigger.textContent || ''))) {
        return;
      }
    }

    menu.dataset.agySearchInjected = 'true';
    installStyles();

    const searchBox = element('div', 'agy-model-search-box');
    const searchInput = element('input', 'agy-model-search-input') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.placeholder = 'Search models…';
    searchInput.setAttribute('aria-label', 'Search models');

    const noResults = element('div', 'agy-model-no-results', 'No models found');
    noResults.style.display = 'none';

    searchBox.append(searchInput);

    const stopBubbling = (e: Event) => e.stopPropagation();
    searchBox.addEventListener('pointerdown', stopBubbling);
    searchBox.addEventListener('mousedown', stopBubbling);
    searchBox.addEventListener('click', stopBubbling);

    const headerNode = Array.from(menu.querySelectorAll<HTMLElement>('*')).find(
      (node) => node.children.length === 0 && node.textContent?.trim() === 'Model',
    );

    if (headerNode) {
      let insertAfter: HTMLElement = headerNode;
      while (
        insertAfter.parentElement &&
        insertAfter.parentElement !== menu &&
        insertAfter.parentElement.children.length === 1
      ) {
        insertAfter = insertAfter.parentElement;
      }
      insertAfter.after(searchBox);
    } else {
      menu.prepend(searchBox);
    }
    searchBox.after(noResults);

    function getItems(): HTMLElement[] {
      let rows = Array.from(
        menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], button'),
      );
      if (rows.length === 0) {
        const scroll = menu.querySelector<HTMLElement>('.overflow-y-auto, [style*="overflow"]') || menu;
        rows = Array.from(scroll.children) as HTMLElement[];
      }
      return rows.filter((row) => {
        if (row === searchBox || row.contains(searchBox) || searchBox.contains(row)) return false;
        if (row === noResults || row.contains(noResults)) return false;
        const txt = (row.textContent || '').trim();
        if (!txt || txt === 'Model') return false;
        if (/^View\s+Usage/i.test(txt)) return false;
        return true;
      });
    }

    function filter(): void {
      const query = searchInput.value.trim().toLowerCase();
      const items = getItems();
      let matchCount = 0;

      for (const item of items) {
        const itemText = (item.textContent || '').replace(/\s+/g, ' ').toLowerCase();
        const matches = !query || itemText.includes(query);
        if (matches) {
          item.style.removeProperty('display');
          matchCount++;
        } else {
          item.style.setProperty('display', 'none', 'important');
        }
      }

      if (query && matchCount === 0) {
        noResults.textContent = `No models matching "${searchInput.value.trim()}"`;
        noResults.style.display = 'block';
      } else {
        noResults.style.display = 'none';
      }
    }

    searchInput.addEventListener('input', filter);

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const visible = getItems().filter((item) => item.style.display !== 'none');
        if (visible.length > 0) {
          visible[0].focus();
          visible[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const visible = getItems().filter((item) => item.style.display !== 'none');
        if (visible.length > 0) {
          const target = visible.find((el) => el.matches(':focus, :focus-within, [data-highlighted], .active')) || visible[0];
          target.click();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (searchInput.value) {
          e.preventDefault();
          e.stopPropagation();
          searchInput.value = '';
          filter();
        }
        return;
      }

      e.stopPropagation();
    });

    setTimeout(() => {
      searchInput.focus();
    }, 20);
  }

  function checkAndAttachModelSearch(): void {
    if (activeModelMenu && activeModelMenu.isConnected && isDropdownVisible(activeModelMenu)) {
      return;
    }

    activeModelMenu = findModelPickerDropdown();
    const existingBoxes = Array.from(document.querySelectorAll<HTMLElement>('.agy-model-search-box'));
    for (const box of existingBoxes) {
      if (!activeModelMenu || !activeModelMenu.contains(box)) {
        box.remove();
      }
    }
    if (activeModelMenu) {
      attachModelPickerSearch(activeModelMenu);
    }
  }

  function setupInjectionObserver(): void {
    injectCustomModelsSection();
    if (!document?.body || typeof document?.createElement !== 'function') return;
    installStyles();
    checkAndAttachModelSearch();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      checkAndAttachModelSearch();
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        injectCustomModelsSection();
      }, 150);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-state'],
    });

    if (typeof document?.addEventListener === 'function') {
      document.addEventListener(
        'click',
        () => {
          requestAnimationFrame(checkAndAttachModelSearch);
        },
        true,
      );

      document.addEventListener(
        'keyup',
        (e) => {
          if (['Enter', 'Space', ' '].includes(e.key)) {
            requestAnimationFrame(checkAndAttachModelSearch);
          }
        },
        true,
      );
    }

    window.addEventListener(
      'pagehide',
      () => {
        observer.disconnect();
        if (pending) clearTimeout(pending);
      },
      { once: true },
    );
  }

  // --- Network Interceptor for Model Injection --------------------------

  function isSafeToIntercept(url: string): boolean {
    // Never touch the internal Connect-RPC LanguageServerService channel —
    // those responses are protocol-framed, not plain JSON, and rewriting
    // them corrupts the renderer's RPC client / store hydration.
    if (url.includes('exa.language_server_pb.')) return false;
    if (url.includes('/LanguageServerService/')) return false;
    return true;
  }

  function isJsonResponse(contentType: string | null): boolean {
    return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
  }

  const customModelsCache: { models: any[]; ts: number } = { models: [], ts: 0 };

  function injectMissingCustomModels(parsed: Record<string, unknown>, customModels: any[]): boolean {
    const key = ['models', 'availableModels', 'available_models'].find((name) => parsed[name] !== undefined) || 'models';
    const collection = parsed[key];
    // Preserve list/protocol shapes we do not own; the proxy handles array catalogs.
    if (collection !== undefined && (!collection || typeof collection !== 'object' || Array.isArray(collection))) return false;
    const modelsObj = (collection || {}) as Record<string, any>;
    const legacySlug = (model: any) => 'custom-' + String(model.externalModelName || model.name || '')
      .replace(/^models\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const usedLabels = new Set(Object.values(modelsObj).map((entry) => entry?.displayName).filter((label) => typeof label === 'string'));
    let changed = false;
    for (const model of customModels) {
      if (model.nativePickerAvailable === false) continue;
      const authoritative = typeof model.nativeCatalogId === 'string' && typeof model.nativeModelId === 'string';
      const slug = authoritative ? model.nativeCatalogId : legacySlug(model);
      // Compatibility with older IPC: never guess a shared external alias for effort variants.
      if (!authoritative && customModels.filter((other) => legacySlug(other) === slug).length !== 1) continue;
      const placeholder = authoritative ? model.nativeModelId : 'MODEL_PLACEHOLDER_M' +
        (400 + hashCodeStr(String(model.displayName || model.name || 'custom-model').toLowerCase()) % 200);
      const baseLabel = model.displayName || model.name;
      // The proxy is authoritative. Reinjection must not overwrite its capabilities or add a legacy duplicate.
      if (Object.prototype.hasOwnProperty.call(modelsObj, slug) || Object.entries(modelsObj).some(([id, entry]) =>
        id.startsWith('custom-') && entry?.model === placeholder && entry.displayName === baseLabel,
      )) continue;
      let displayName = baseLabel;
      if (usedLabels.has(displayName) || customModels.filter((entry) => (entry.displayName || entry.name) === baseLabel).length > 1)
        displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')})`;
      let suffix = 2;
      while (usedLabels.has(displayName)) displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')} #${suffix++})`;
      usedLabels.add(displayName);
      modelsObj[slug] = {
        displayName, recommended: true,
        maxTokens: model.nativeContextWindow || model.contextWindow || 1048576,
        maxOutputTokens: model.nativeMaxOutputTokens || model.maxOutputTokens || 4096,
        tokenizerType: 'LLAMA_WITH_SPECIAL', model: placeholder,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE',
        ...(authoritative && model.nativeModelExperiments ? { modelExperiments: model.nativeModelExperiments } : {}),
      };
      changed = true;
    }
    if (changed) parsed[key] = modelsObj;
    return changed;
  }

  async function getCustomModelsForInjection(): Promise<any[]> {
    if (Date.now() - customModelsCache.ts < 30000) return customModelsCache.models;
    try {
      customModelsCache.models = (await storageAPI.getCustomModels()).filter((model) => model.enabled !== false);
      customModelsCache.ts = Date.now();
    } catch {
      /* ignore */
    }
    return customModelsCache.models;
  }

  // Intercept XHR to inject custom models into GetAvailableModels responses
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    (this as any)._agy_url = typeof url === 'string' ? url : url.toString();
    (this as any)._agy_method = method;
    (this as any)._agy_async = async !== false;
    return origXHROpen.call(this, method, url, async !== false, username, password);
  };

  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const url: string = (this as any)._agy_url || '';

    if ((url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) && isSafeToIntercept(url)) {
      // Warm the cache without delaying native XHR events. If it is not ready by
      // DONE, leave the response alone; load/readystatechange ordering must survive.
      if ((this as any)._agy_async) void getCustomModelsForInjection();
      const origOnReady = this.onreadystatechange;
      this.onreadystatechange = (ev: Event) => {
        if (
          this.readyState === 4 &&
          this.status === 200 &&
          (this.responseType === '' || this.responseType === 'text') &&
          isJsonResponse(this.getResponseHeader('content-type'))
        ) {
          const customModels = customModelsCache.models;
          if (customModels && customModels.length > 0) {
            try {
              const responseText = this.responseText;
              if (responseText && responseText.length > 10) {
                const parsed = JSON.parse(responseText) as Record<string, unknown>;
                if (injectMissingCustomModels(parsed, customModels)) {
                  // Override only a changed response; keep native event ordering intact.
                  Object.defineProperty(this, 'responseText', { value: JSON.stringify(parsed), writable: true });
                  Object.defineProperty(this, 'response', { value: JSON.stringify(parsed), writable: true });
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
        if (origOnReady) origOnReady.call(this, ev);
      };
    }
    return origXHRSend.call(this, body);
  };

  // Intercept fetch responses for model endpoints
  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await origFetch.call(window, input, init);

    if (
      (url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) &&
      isSafeToIntercept(url) &&
      response.ok
    ) {
      if (!isJsonResponse(response.headers.get('content-type'))) {
        return response;
      }
      const customModels = await getCustomModelsForInjection();
      if (customModels && customModels.length > 0) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text && text.length > 10) {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (!injectMissingCustomModels(parsed, customModels)) return response;
            return new Response(JSON.stringify(parsed), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }
    return response;
  };

  function hashCodeStr(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i);
      h = h & h;
    }
    return Math.abs(h);
  }

  // Start the observer
  setupInjectionObserver();
});
