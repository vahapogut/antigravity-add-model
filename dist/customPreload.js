"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** Custom-model UI, appended to the vendor preload. Sandboxed preloads require Electron only. */
const electron_1 = require("electron");
const storageAPI = {
    getCustomModels: () => electron_1.ipcRenderer.invoke('storage:get-custom-models'),
    saveCustomModel: (model) => electron_1.ipcRenderer.invoke('storage:save-custom-model', model),
    deleteCustomModel: (name) => electron_1.ipcRenderer.invoke('storage:delete-custom-model', name),
    testModelConnection: (model) => electron_1.ipcRenderer.invoke('storage:test-model-connection', model),
    testModelGeneration: (model) => electron_1.ipcRenderer.invoke('storage:test-model-generation', model),
    getPresets: () => electron_1.ipcRenderer.invoke('storage:get-provider-presets'),
    discoverModels: (params) => electron_1.ipcRenderer.invoke('storage:discover-models', params),
    getChatContextUsage: (payload) => electron_1.ipcRenderer.invoke('storage:get-chat-context-usage', payload),
};
window.addEventListener('DOMContentLoaded', () => {
    let modelList = [];
    let renderVersion = 0;
    let searchTerm = '';
    let cancelModalOperation;
    const requireSuccess = (result) => {
        if (!result?.success)
            throw new Error(result?.error || 'The operation could not be completed.');
        return result;
    };
    function element(tag, className = '', text = '') {
        const node = document.createElement(tag);
        node.className = className;
        if (text)
            node.textContent = text;
        return node;
    }
    function setStatus(target, text, error = false) {
        target.textContent = text;
        target.className = `agy-status${error ? ' agy-error' : ''}`;
    }
    function statusNode() {
        const node = element('div', 'agy-status');
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        return node;
    }
    function button(label, action, status, primary = false) {
        const node = element('button', `agy-btn${primary ? ' agy-primary' : ''}`, label);
        node.type = 'button';
        node.addEventListener('click', async () => {
            if (node.disabled)
                return;
            node.disabled = true;
            try {
                await action();
            }
            catch (error) {
                const target = status || document.getElementById('agy-main-status');
                if (target)
                    setStatus(target, error instanceof Error ? error.message : String(error), true);
            }
            finally {
                node.disabled = false;
            }
        });
        return node;
    }
    function field(parent, title, id, value = '', type = 'text') {
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
    function selectField(parent, title, id, options, value) {
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
    function jsonField(parent, title, id, value) {
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
    function readJson(input, title) {
        if (!input.value.trim())
            return undefined;
        try {
            const value = JSON.parse(input.value);
            if (!value || Array.isArray(value) || typeof value !== 'object')
                throw new Error();
            return value;
        }
        catch {
            throw new Error(`${title} must be a JSON object.`);
        }
    }
    function readNumber(input, title, minimum = 0) {
        if (!input.value.trim())
            return undefined;
        const value = Number(input.value);
        if (!Number.isSafeInteger(value) || value < minimum)
            throw new Error(`${title} must be a whole number of at least ${minimum}.`);
        return value;
    }
    function validUrl(value) {
        let url;
        try {
            url = new URL(value.trim());
        }
        catch {
            throw new Error('Enter a complete http:// or https:// API URL.');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Use an HTTP or HTTPS URL. Enter credentials in the API key field.');
        return value.trim();
    }
    function installStyles() {
        if (document.getElementById('agy-manager-style'))
            return;
        const style = element('style');
        style.id = 'agy-manager-style';
        style.textContent = `
      #agy-custom-models-section,#agy-modal-overlay{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e4e7;box-sizing:border-box}
      #agy-custom-models-section *,#agy-modal-overlay *{box-sizing:border-box}
      #agy-custom-models-section [hidden],#agy-modal-overlay [hidden]{display:none!important}
      #agy-custom-models-section{margin:24px 0;padding:20px;border:1px solid #303036;border-radius:12px;background:#18181b;min-width:0}
      #agy-custom-models-section h2,#agy-modal-overlay h2{font-size:18px;margin:0;color:#fafafa;font-weight:600}
      #agy-custom-models-section h3{font-size:13px;margin:0;color:#f4f4f5}
      .agy-toolbar,.agy-actions,.agy-group-heading,.agy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .agy-toolbar{justify-content:space-between;margin-bottom:12px}.agy-actions{margin:10px 0}
      .agy-muted{color:#a1a1aa;font-size:12px;overflow-wrap:anywhere}.agy-group{margin-top:16px;border-top:1px solid #303036;padding-top:14px}
      .agy-group-heading{justify-content:space-between}.agy-row{justify-content:space-between;border:1px solid #303036;border-radius:8px;padding:12px;margin-top:8px;background:#202024}
      .agy-row-info{flex:1;min-width:150px;overflow-wrap:anywhere}.agy-row[data-enabled="false"] .agy-row-info{opacity:.55}
      #agy-custom-models-section .agy-btn,#agy-modal-overlay .agy-btn{appearance:none;font:inherit;color:#e4e4e7;background:#27272c;border:1px solid #414149;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
      #agy-custom-models-section .agy-primary,#agy-modal-overlay .agy-primary{background:#e4e4e7;color:#18181b;border-color:#e4e4e7;font-weight:600}
      #agy-custom-models-section .agy-btn:hover,#agy-modal-overlay .agy-btn:hover{filter:brightness(1.12)}
      #agy-custom-models-section .agy-btn:disabled,#agy-modal-overlay .agy-btn:disabled{opacity:.5;cursor:wait}
      #agy-custom-models-section :focus-visible,#agy-modal-overlay :focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
      .agy-status{color:#86efac;font-size:12px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}.agy-status:empty{display:none}.agy-error{color:#fca5a5}
      .agy-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;min-width:0;color:#a1a1aa}
      #agy-custom-models-section input,#agy-modal-overlay input,#agy-modal-overlay select,#agy-modal-overlay textarea,#agy-custom-models-section select{font:inherit;width:100%;background:#25252a!important;border:1px solid #414149!important;border-radius:6px!important;color:#fafafa!important;padding:8px 10px;min-width:0}
      #agy-custom-models-section select option,#agy-modal-overlay select option,select option,option{background:#202024!important;color:#fafafa!important;padding:6px 10px}
      #agy-fleet-target-pool{background:#25252a!important;color:#fafafa!important;border:1px solid #414149!important;border-radius:6px!important;padding:6px 10px!important;max-width:280px;width:auto}
      #agy-fleet-target-pool option{background:#202024!important;color:#fafafa!important}
      option:checked,select option:checked{background:#2563eb!important;color:#ffffff!important}
      #agy-modal-overlay textarea{font-family:ui-monospace,monospace;resize:vertical}#agy-modal-overlay input[type=checkbox]{width:auto;accent-color:#a78bfa}
      #agy-modal-overlay{position:fixed;inset:0;z-index:999999;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px}
      #agy-modal-card{width:680px;max-width:100%;max-height:90vh;overflow:auto;background:#18181b;border:1px solid #414149;border-radius:12px;padding:24px;box-shadow:0 24px 80px #0008}
      .agy-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.agy-discovery{max-height:240px;overflow:auto;margin:12px 0}
      .agy-choice{display:flex;gap:10px;align-items:center;padding:7px 0;overflow-wrap:anywhere}.agy-choice span{min-width:0}
      #agy-modal-overlay details{border:1px solid #303036;border-radius:8px;margin:12px 0;padding:12px}#agy-modal-overlay summary{cursor:pointer;margin-bottom:10px;font-weight:500}
      .agy-fleet{margin:18px 0;border:1px solid #303036;border-radius:8px;padding:14px;box-sizing:border-box;width:100%}.agy-fleet-table-wrap{overflow-x:auto;width:100%;box-sizing:border-box}.agy-fleet-table{width:100%;border-collapse:separate;border-spacing:0 12px;text-align:left}.agy-fleet-table thead{display:none}.agy-fleet-table th,.agy-fleet-table td{padding:0;border:none;vertical-align:top}.agy-fleet-card-cell{width:100%}.agy-fleet-card{width:100%;box-sizing:border-box;min-width:0;background:#202024;border:1px solid #303036;border-radius:10px;padding:14px 16px;transition:border-color 0.2s ease}.agy-fleet-card:hover{border-color:#3f3f46}
      .agy-card-disabled{opacity:0.72}
      .agy-fleet-header{margin-bottom:12px}
      .agy-fleet-title-wrapper{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
      .agy-fleet-chevron{font-size:11px;color:#a1a1aa;transition:transform 0.15s ease}
      .agy-fleet-card-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;min-width:0;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06)}.agy-fleet-card-header-info{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;flex:1 1 240px}
      .agy-fleet-label{font-weight:600;font-size:13px;color:#f4f4f5;min-width:0;overflow-wrap:anywhere;word-break:break-all}.agy-pool-badge{display:inline-block;padding:2px 6px;border-radius:5px;background:#27272c;color:#a1a1aa;font-size:11px;flex-shrink:0}.agy-pool-preferred{color:#86efac}.agy-badge-pro{background:#064e3b!important;color:#34d399!important;border:1px solid #059669!important}.agy-model-search-box{padding:6px 8px}.agy-model-search-input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid #52525b;border-radius:5px;padding:6px}.agy-model-no-results{padding:8px;color:#a1a1aa;font-size:12px}
      .agy-actions.agy-fleet-account-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end;margin:0;min-width:0}.agy-actions.agy-fleet-account-actions button{padding:4px 10px;font-size:11px;border-radius:5px;white-space:nowrap;flex-shrink:0;min-width:65px;text-align:center}
      .agy-fleet-account-quotas{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;width:100%;box-sizing:border-box;min-width:0;margin:12px 0;padding:10px 14px;background:#18181c;border-radius:8px;border:1px solid #2a2a30}
      .agy-quota-section{display:flex;flex-direction:column;gap:8px;min-width:0}.agy-quota-section-title{font-size:12px;font-weight:700;color:#e4e4e7;letter-spacing:0.02em}
      .agy-quota-bucket{display:flex;flex-direction:column;gap:3px;min-width:0;width:100%}.agy-quota-bucket-header{display:flex;justify-content:space-between;align-items:center;font-size:11px;gap:8px;min-width:0}.agy-quota-bucket-name{color:#a1a1aa;min-width:0;overflow-wrap:anywhere;word-break:break-word}.agy-quota-bucket-pct{font-weight:600;color:#f4f4f5;flex-shrink:0}.agy-quota-bucket-pct.exhausted{color:#f87171}.agy-quota-bucket progress{display:block;width:100%;max-width:100%;box-sizing:border-box;height:6px;border-radius:3px;overflow:hidden;background:#27272a;accent-color:#22c55e}.agy-quota-bucket progress.exhausted{accent-color:#ef4444}.agy-quota-reset{font-size:10px;color:#71717a}
      .agy-fleet-pools-section{margin-top:10px;min-width:0;width:100%;box-sizing:border-box}.agy-fleet-pools-heading{font-size:11px;font-weight:600;color:#a1a1aa;margin-bottom:8px;letter-spacing:0.02em;text-transform:uppercase}
      .agy-fleet-pools-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;width:100%;box-sizing:border-box;min-width:0}
      .agy-fleet-pool{display:flex;flex-direction:column;justify-content:space-between;gap:6px;background:#18181c;border:1px solid #303036;border-radius:6px;padding:8px 12px;min-width:0;box-sizing:border-box;transition:border-color 0.15s ease}.agy-fleet-pool:hover{border-color:#3f3f46}.agy-pool-info{min-width:0;width:100%}.agy-pool-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;min-width:0}.agy-pool-name{font-weight:600;font-size:12px;color:#f4f4f5;min-width:0;overflow-wrap:anywhere;word-break:break-all}.agy-pool-meta{font-size:11px;color:#a1a1aa;min-width:0;overflow-wrap:anywhere;word-break:break-all}.agy-pool-actions{margin:0;padding-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0}.agy-pool-actions button{padding:3px 8px;font-size:11px;border-radius:4px;white-space:nowrap}.agy-pool-actions button:first-child{min-width:96px;text-align:center}
      .agy-fleet-toggle{display:inline-flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;color:#e4e4e7;user-select:none;margin-left:12px;padding:0;background:none;border:none}.agy-fleet-toggle:hover{opacity:0.9}.agy-fleet-toggle-label{font-weight:500;color:#d4d4d8}.agy-switch{position:relative;display:inline-block;width:32px;height:18px;background:#3f3f46;border-radius:10px;transition:background 0.2s cubic-bezier(0.4,0,0.2,1);vertical-align:middle;flex-shrink:0}.agy-switch-input{position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none}.agy-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.4);transition:transform 0.2s cubic-bezier(0.4,0,0.2,1)}.agy-switch-input:checked+.agy-switch-thumb{transform:translateX(14px)}.agy-switch:has(.agy-switch-input:checked){background:#22c55e}.agy-switch-status{font-size:11px;font-weight:600;color:#71717a;letter-spacing:0.02em}.agy-switch-status-active{color:#4ade80}
      .agy-pool-disabled{color:#fca5a5!important;background:#3f1d1d!important;border:1px solid #7f1d1d!important}
      .agy-context-ring{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:20px!important;height:20px!important;margin-left:6px!important;margin-right:2px!important;position:relative!important;user-select:none!important;flex-shrink:0!important;vertical-align:middle!important;cursor:pointer!important;border-radius:50%!important;align-self:center!important;transition:transform 0.15s ease,filter 0.15s ease!important}
      .agy-context-ring:hover{transform:scale(1.15)!important;filter:brightness(1.2)!important}
      .agy-context-ring:focus-visible{outline:2px solid #a78bfa!important;outline-offset:2px!important}
      .agy-context-ring svg{transform:rotate(-90deg)!important;display:block!important}
      #agy-context-floating-tooltip{position:fixed!important;z-index:99999999!important;pointer-events:none!important;background:#18181c!important;color:#f4f4f5!important;border:1px solid #3f3f46!important;border-radius:6px!important;padding:5px 9px!important;font:500 11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;box-shadow:0 4px 16px rgba(0,0,0,0.5)!important;white-space:nowrap!important;transform:translate(-50%,-100%)!important;opacity:0;display:none;transition:opacity 0.12s ease!important}
      @media(max-width:600px){.agy-grid{grid-template-columns:1fr}#agy-modal-card{padding:16px}.agy-row .agy-actions{width:100%}}
    `;
        document.head.append(style);
    }
    function openModal(title) {
        cancelModalOperation?.();
        cancelModalOperation = undefined;
        document.getElementById('agy-modal-overlay')?.remove();
        const previousFocus = document.activeElement;
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
            if (!overlay.isConnected)
                return;
            cancelModalOperation?.();
            cancelModalOperation = undefined;
            overlay.remove();
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
        header.append(heading, button('Close', close));
        const body = element('div');
        const status = statusNode();
        card.append(header, body, status);
        overlay.append(card);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay)
                close();
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
            if (event.key !== 'Tab')
                return;
            const controls = Array.from(card.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea,summary'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        });
        document.body.append(overlay);
        header.querySelector('button')?.focus();
        return { body, status, close };
    }
    function createGoogleAccountPanel(parent, initialAccounts, modelName) {
        let accounts = initialAccounts.map((account) => ({ ...account }));
        const locallyEdited = new Set();
        let accountOperationAttempt = 0;
        let accountOperationPending = false;
        const panel = element('details');
        panel.open = true;
        panel.append(element('summary', '', 'Google accounts'));
        panel.append(element('p', 'agy-muted', 'Add up to 50 accounts you own using Antigravity sign-in, your Desktop OAuth client, or a credential file. Save the model to retain changes. Existing secrets stay masked. Prepare account checks the Cloud Code project and may activate the available free tier.'));
        const list = element('div');
        list.id = 'agy-google-accounts-list';
        const editor = element('div');
        const status = statusNode();
        const randomId = () => `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const addAccount = (account) => {
            if (!account.id || (!account.refreshToken && !account.accessToken))
                throw new Error('An account needs an ID and a refresh token or access token.');
            if (account.refreshToken && !account.clientId)
                throw new Error('An OAuth client ID is required with a refresh token.');
            const index = accounts.findIndex((value) => value.id === account.id);
            if (index < 0) {
                if (accounts.length >= 50)
                    throw new Error('A model can contain at most 50 Google accounts.');
                accounts.push(account);
            }
            else
                accounts[index] = account;
            locallyEdited.add(account.id);
            renderAccounts();
        };
        function editAccount(account) {
            editor.replaceChildren();
            editor.append(element('h3', '', account ? 'Edit account' : 'Add account credentials'));
            const accountGrid = element('div', 'agy-grid');
            const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || randomId());
            const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || '');
            const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
            const clientSecret = field(accountGrid, 'OAuth client secret (if required)', 'agy-account-client-secret', account?.clientSecret || '', 'password');
            const refresh = field(accountGrid, 'Refresh token', 'agy-account-refresh-token', account?.refreshToken || '', 'password');
            const access = field(accountGrid, 'Access token (optional with refresh token)', 'agy-account-access-token', account?.accessToken || '', 'password');
            const expires = field(accountGrid, 'Access token expiry (Unix milliseconds)', 'agy-account-expires-at', account?.expiresAt != null ? String(account.expiresAt) : '', 'number');
            const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
            editor.append(accountGrid);
            const actions = element('div', 'agy-actions');
            actions.append(button('Apply account', () => {
                const accountId = id.value.trim();
                if (account && accountId !== account.id && accounts.some((value) => value.id === accountId))
                    throw new Error('That account ID already exists.');
                const updated = {
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
                if (account &&
                    accountId !== account.id &&
                    [updated.refreshToken, updated.accessToken, updated.clientSecret].some((value) => value?.includes('***')))
                    throw new Error('Keep the account ID unchanged when using masked credentials.');
                addAccount(updated);
                if (account && accountId !== account.id)
                    accounts = accounts.filter((value) => value.id !== account.id);
                editor.replaceChildren();
                renderAccounts();
                setStatus(status, 'Account updated. Save the model to keep these changes.');
            }, status), button('Cancel account edit', () => editor.replaceChildren(), status));
            editor.append(actions);
        }
        function renderAccounts() {
            list.replaceChildren();
            if (!accounts.length)
                list.append(element('p', 'agy-muted', 'No Google accounts configured.'));
            for (const account of accounts) {
                const row = element('div', 'agy-row');
                const info = element('div', 'agy-row-info');
                info.append(element('strong', '', account.label || account.id), element('div', 'agy-muted', `${account.id} · ${account.enabled === false ? 'Disabled' : 'Enabled'}${account.project ? ` · ${account.project}` : ''}`));
                const actions = element('div', 'agy-actions');
                actions.append(button('Edit account', () => editAccount(account), status), button(account.enabled === false ? 'Enable account' : 'Disable account', () => {
                    account.enabled = account.enabled === false;
                    renderAccounts();
                }, status), button('Test account', async () => {
                    setStatus(status, 'Checking account access and quota…');
                    const result = await electron_1.ipcRenderer.invoke('storage:google-test-account', modelName && !locallyEdited.has(account.id)
                        ? { modelName, accountId: account.id }
                        : { account, ...(modelName ? { modelName } : {}) });
                    requireSuccess(result);
                    setStatus(status, result.message ||
                        (result.quota
                            ? `Account verified. Quota: ${JSON.stringify(result.quota)}`
                            : 'Account verified. Generation was not tested.'));
                }, status), button('Prepare account', async () => {
                    if (accountOperationPending)
                        throw new Error('Wait for the current Google account operation or cancel it.');
                    accountOperationPending = true;
                    const attempt = ++accountOperationAttempt;
                    const cancel = () => {
                        accountOperationAttempt++;
                        void electron_1.ipcRenderer.invoke('storage:google-login-cancel').catch(() => { });
                    };
                    cancelModalOperation = cancel;
                    try {
                        setStatus(status, 'Preparing account access and Cloud Code project…');
                        const result = await electron_1.ipcRenderer.invoke('storage:google-account-prepare', {
                            ...(modelName && !locallyEdited.has(account.id)
                                ? { modelName, accountId: account.id }
                                : { account, ...(modelName ? { modelName } : {}) }),
                            allowOnboard: true,
                        });
                        if (!panel.isConnected || accountOperationAttempt !== attempt)
                            return;
                        requireSuccess(result);
                        if (!accounts.some((value) => value.id === account.id))
                            return;
                        if (!result.account || result.account.id !== account.id)
                            throw new Error('Account preparation did not return the selected account.');
                        addAccount({ ...account, ...result.account });
                        setStatus(status, result.message ||
                            'Account prepared. Save the model to retain the project. Generation was not tested.');
                    }
                    finally {
                        accountOperationPending = false;
                        if (cancelModalOperation === cancel)
                            cancelModalOperation = undefined;
                    }
                }, status), button('Remove account', () => {
                    accounts = accounts.filter((value) => value.id !== account.id);
                    locallyEdited.delete(account.id);
                    renderAccounts();
                }, status));
                row.append(info, actions);
                list.append(row);
            }
        }
        const actions = element('div', 'agy-actions');
        actions.append(button('Add account', () => editAccount(), status), button('Pool status', async () => {
            const result = await electron_1.ipcRenderer.invoke('storage:google-pool-status');
            if (result?.success === false)
                requireSuccess(result);
            setStatus(status, JSON.stringify(result, null, 2));
        }, status));
        const login = element('details');
        login.append(element('summary', '', 'Sign in with Google'));
        const loginMode = selectField(login, 'Sign-in method', 'agy-google-login-auth-mode', [
            ['antigravity', 'Antigravity account'],
            ['custom', 'My Desktop OAuth client'],
        ], 'antigravity');
        const loginHelp = element('p', 'agy-muted');
        login.append(loginHelp);
        const loginLabel = field(login, 'Account label', 'agy-google-login-label');
        const loginClient = field(login, 'Desktop OAuth client ID', 'agy-google-login-client-id');
        const loginSecret = field(login, 'OAuth client secret (if required)', 'agy-google-login-client-secret', '', 'password');
        const updateLoginMode = () => {
            const native = loginMode.value === 'antigravity';
            loginClient.closest('label').hidden = native;
            loginSecret.closest('label').hidden = native;
            loginHelp.textContent = native
                ? 'Sign in through your browser using the installed Antigravity app’s OAuth client. This prepares your Cloud Code project and may activate the available free tier. A recognized Antigravity installation is required. Repeat for each account, then save the model. Generation must be tested separately.'
                : 'Enter a Desktop OAuth client from your Google Cloud project. Your project and account must have access to the configured Cloud Code service. Repeat Sign in with Google for each account, then save the model.';
        };
        loginMode.addEventListener('change', updateLoginMode);
        updateLoginMode();
        const loginActions = element('div', 'agy-actions');
        loginActions.append(button('Sign in with Google', async () => {
            const authMode = loginMode.value === 'custom' ? 'custom' : 'antigravity';
            if (authMode === 'custom' && !loginClient.value.trim())
                throw new Error('Enter your Desktop OAuth client ID.');
            if (accountOperationPending)
                throw new Error('Wait for the current Google account operation or cancel it.');
            accountOperationPending = true;
            const attempt = ++accountOperationAttempt;
            const cancel = () => {
                accountOperationAttempt++;
                void electron_1.ipcRenderer.invoke('storage:google-login-cancel').catch(() => { });
            };
            cancelModalOperation = cancel;
            for (const input of [loginMode, loginLabel, loginClient, loginSecret])
                input.disabled = true;
            setStatus(status, authMode === 'antigravity'
                ? 'Complete consent in your browser, then wait for account preparation. Browser login expires after two minutes.'
                : 'Complete consent in your browser. This login expires after two minutes.');
            try {
                const result = await electron_1.ipcRenderer.invoke('storage:google-login', {
                    authMode,
                    ...(authMode === 'custom'
                        ? { clientId: loginClient.value.trim(), clientSecret: loginSecret.value.trim() || undefined }
                        : {}),
                    label: loginLabel.value.trim() || undefined,
                });
                if (!panel.isConnected || accountOperationAttempt !== attempt)
                    return;
                requireSuccess(result);
                if (!result.account)
                    throw new Error('Google login did not return an account.');
                addAccount(result.account);
                loginSecret.value = '';
                setStatus(status, 'Account authorized. Save the model within 10 minutes to retain it; otherwise sign in again. Use Test account to check service access and quota, then Test generation to verify a model response.');
            }
            finally {
                accountOperationPending = false;
                for (const input of [loginMode, loginLabel, loginClient, loginSecret])
                    input.disabled = false;
                if (cancelModalOperation === cancel)
                    cancelModalOperation = undefined;
            }
        }, status), button('Cancel Google login', async () => {
            accountOperationAttempt++;
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-login-cancel'));
            cancelModalOperation = undefined;
            setStatus(status, 'Google login cancelled.');
        }, status));
        login.append(loginActions);
        const importer = element('details');
        importer.append(element('summary', '', 'Import account credentials'));
        importer.append(element('p', 'agy-muted', 'Import your own authorized_user JSON, an account object, or an accounts array. Importing does not open a browser or make network requests.'));
        const accountJson = jsonField(importer, 'Account JSON', 'agy-google-account-json', undefined);
        const file = field(importer, 'Credential JSON file', 'agy-google-account-file', '', 'file');
        file.accept = '.json,application/json';
        file.addEventListener('change', async () => {
            try {
                const selected = file.files?.[0];
                if (!selected)
                    return;
                if (selected.size > 512 * 1024)
                    throw new Error('Account files must be smaller than 512 KB.');
                accountJson.value = await selected.text();
            }
            catch (error) {
                setStatus(status, String(error), true);
            }
        });
        importer.append(button('Import accounts', () => {
            let data;
            try {
                data = JSON.parse(accountJson.value);
            }
            catch {
                throw new Error('Account credentials must be valid JSON.');
            }
            const root = data;
            const values = Array.isArray(data) ? data : root?.accounts || root?.googleAccounts || [data];
            if (!Array.isArray(values) || !values.length || values.length + accounts.length > 50)
                throw new Error('Import between 1 and 50 accounts.');
            const incoming = values.map((value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error('Each account must be a JSON object.');
                const entry = value;
                const text = (key, alternate = key) => String(entry[key] || entry[alternate] || '');
                const account = {
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
            for (const account of incoming)
                addAccount(account);
            accountJson.value = '';
            file.value = '';
            setStatus(status, `Imported ${incoming.length} accounts. Save the model to encrypt and retain them.`);
        }, status));
        panel.append(list, actions, editor, login, importer, status);
        parent.append(panel);
        renderAccounts();
        return () => accounts.map((account) => ({ ...account }));
    }
    const nonSettingsContent = '#agy-custom-models-section,#agy-modal-overlay,button,nav,[role="tablist"],article,[role="article"],pre,code,' +
        '[data-testid="conversation-view"],[data-testid="autoscroll-viewport"],[role="log"]';
    function isSettingsContent(node) {
        if (node.closest(nonSettingsContent))
            return false;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true')
                return false;
            const style = window.getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    }
    function findRefreshButton(root) {
        return (Array.from(root.querySelectorAll('button')).find((node) => !node.closest('#agy-custom-models-section') &&
            isSettingsContent(node.parentElement || node) &&
            (node.textContent?.trim() === 'Refresh' ||
                /refresh quota/i.test(`${node.getAttribute('aria-label') || ''} ${node.title || ''}`))) || null);
    }
    async function modelsChanged() {
        customModelsCache.ts = 0;
        const scrollTarget = document.getElementById('agy-custom-models-section') || document.body;
        const restore = captureScrollPosition(scrollTarget);
        await renderCustomModelsList(false);
        const mount = findSettingsMount();
        if (mount)
            findRefreshButton(mount)?.click();
        restore();
    }
    function uniqueName(base) {
        let name = base, index = 2;
        while (modelList.some((model) => model.name === name))
            name = `${base}-${index++}`;
        return name;
    }
    function captureScrollPosition(node) {
        const positions = new Map();
        for (let parent = node; parent; parent = parent.parentElement) {
            if (parent.scrollTop > 0 || parent.scrollLeft > 0 || window.getComputedStyle(parent).overflowY !== 'visible') {
                positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
            }
        }
        const scrollingElement = document.scrollingElement;
        if (scrollingElement && !positions.has(scrollingElement))
            positions.set(scrollingElement, { top: scrollingElement.scrollTop, left: scrollingElement.scrollLeft });
        return () => {
            const apply = () => {
                for (const [element, position] of positions) {
                    if (!element.isConnected)
                        continue;
                    element.scrollTop = position.top;
                    element.scrollLeft = position.left;
                }
            };
            apply();
            requestAnimationFrame(apply);
            setTimeout(apply, 40);
            setTimeout(apply, 120);
        };
    }
    function openDeleteModelModal(model) {
        const { body, status, close } = openModal('Delete model');
        body.append(element('p', '', `Delete “${model.displayName || model.name}”?`), element('p', 'agy-muted', 'This removes the saved model configuration from this app.'));
        const actions = element('div', 'agy-actions');
        actions.append(button('Cancel', close), button('Delete model', async () => {
            const visibleRows = Array.from(document.querySelectorAll('#agy-custom-models-content [data-model-name]'));
            const deletedIndex = visibleRows.findIndex((row) => row.dataset.modelName === model.name);
            const adjacentNames = [...visibleRows.slice(deletedIndex + 1), ...visibleRows.slice(0, deletedIndex).reverse()]
                .map((row) => row.dataset.modelName);
            setStatus(status, 'Deleting model…');
            requireSuccess(await storageAPI.deleteCustomModel(model.name));
            // The user may have closed this dialog while storage was updating.
            const dialogStillOpen = body.isConnected;
            if (dialogStillOpen)
                close();
            const focusAfterClose = document.activeElement;
            await modelsChanged();
            if (dialogStillOpen && !document.getElementById('agy-modal-overlay') &&
                (document.activeElement === document.body || document.activeElement === focusAfterClose)) {
                const remainingRows = Array.from(document.querySelectorAll('#agy-custom-models-content [data-model-name]'));
                const adjacentRow = adjacentNames.map((name) => remainingRows.find((row) => row.dataset.modelName === name)).find(Boolean);
                const nextFocus = Array.from(adjacentRow?.querySelectorAll('button') || [])
                    .find((button) => button.textContent === 'Delete') || document.getElementById('agy-add-model');
                nextFocus?.focus({ preventScroll: true });
            }
        }, status, true));
        body.append(actions);
    }
    const quotaCache = new Map();
    let fleetRefreshing = false;
    let fleetTimer;
    let googleFleetCollapsed = false;
    try {
        googleFleetCollapsed = localStorage.getItem('agy_google_fleet_collapsed') === 'true';
    }
    catch { }
    function fleetMembers(models) {
        const members = [];
        for (const model of models) {
            if (model.provider !== 'google-cloudcode' || !Array.isArray(model.googleAccounts))
                continue;
            for (const account of model.googleAccounts) {
                if (!account?.id)
                    continue;
                members.push({ account, owner: model });
            }
        }
        return members;
    }
    function fleetAccounts(models) {
        const rows = new Map();
        for (const member of fleetMembers(models)) {
            const { owner, account } = member;
            const email = (quotaCache.get(quotaKey(owner, account))?.quota?.email || account.email)?.trim();
            // An ID is only a fallback identity. Distinct known emails must never merge,
            // and grouping never replaces the original owner/account used by actions.
            const key = email ? `email:${email.toLowerCase()}` : `id:${account.id}`;
            const row = rows.get(key);
            if (row)
                row.members.push(member);
            else
                rows.set(key, { identity: email || account.label || account.id, members: [member] });
        }
        return [...rows.values()];
    }
    function quotaKey(model, account) {
        return JSON.stringify([model.name, model.apiUrl, model.externalModelName, account.id, account.project, account.authMode, account.cloudCodeEndpoint]);
    }
    async function connectFleetAccount(modelName, replaceAccountId) {
        const { body, status, close } = openModal(replaceAccountId ? 'Reconnect Google account' : 'Add Google account');
        body.append(element('p', 'agy-muted', `Complete Google sign-in in your browser. The account is saved to ${modelName}.`));
        cancelModalOperation = () => { void electron_1.ipcRenderer.invoke('storage:google-login-cancel'); };
        setStatus(status, 'Waiting for Google sign-in…');
        try {
            const result = await electron_1.ipcRenderer.invoke('storage:google-login', { authMode: 'antigravity' });
            if (!body.isConnected)
                return;
            requireSuccess(result);
            if (!result.account)
                throw new Error('Google did not return an account.');
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-link-account', { modelName, accountId: result.account.id, ...(replaceAccountId ? { replaceAccountId } : {}) }));
            quotaCache.clear();
            cancelModalOperation = undefined;
            close();
            await modelsChanged();
        }
        catch (error) {
            if (body.isConnected)
                setStatus(status, error instanceof Error ? error.message : String(error), true);
        }
    }
    function removeFleetAccount(account, modelName) {
        const { body, status, close } = openModal('Remove Google account');
        body.append(element('p', '', `Remove ${account.email || account.label || account.id} from ${modelName}? This model will be disabled if no enabled account remains. Other model pools and your IDE login are preserved.`));
        body.append(button('Remove account', async () => {
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-remove-account', { modelName, accountId: account.id }));
            quotaCache.clear();
            close();
            await modelsChanged();
        }, status), button('Cancel', close));
    }
    function openEditFleetAccountModal(accountIdentity, members) {
        const account = members[0]?.account;
        const { body, status, close } = openModal('Edit account');
        const accountGrid = element('div', 'agy-grid');
        const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || '');
        id.readOnly = true;
        const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || account?.email || '');
        const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
        const clientSecret = field(accountGrid, 'OAuth client secret (if required)', 'agy-account-client-secret', account?.clientSecret || '', 'password');
        const refresh = field(accountGrid, 'Refresh token', 'agy-account-refresh-token', account?.refreshToken || '', 'password');
        const access = field(accountGrid, 'Access token (optional with refresh token)', 'agy-account-access-token', account?.accessToken || '', 'password');
        const expires = field(accountGrid, 'Access token expiry (Unix milliseconds)', 'agy-account-expires-at', account?.expiresAt != null ? String(account.expiresAt) : '', 'number');
        const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
        body.append(accountGrid);
        const actions = element('div', 'agy-actions');
        actions.append(button('Apply account', async () => {
            const updated = {
                ...account,
                id: id.value.trim(),
                label: label.value.trim(),
                clientId: clientId.value.trim(),
                clientSecret: clientSecret.value.trim(),
                refreshToken: refresh.value.trim(),
                accessToken: access.value.trim(),
                expiresAt: readNumber(expires, 'Token expiry', 1),
                project: project.value.trim(),
            };
            setStatus(status, 'Saving account changes…');
            for (const { owner } of members) {
                const currentAccounts = Array.isArray(owner.googleAccounts) ? owner.googleAccounts : [];
                const updatedAccounts = currentAccounts.map((a) => {
                    if (a.id === account.id) {
                        return { ...a, ...updated };
                    }
                    return a;
                });
                const updatedModel = {
                    ...owner,
                    googleAccounts: updatedAccounts,
                };
                requireSuccess(await storageAPI.saveCustomModel(updatedModel));
            }
            quotaCache.clear();
            close();
            await modelsChanged();
        }, status, true), button('Cancel account edit', close));
        body.append(actions);
    }
    let fleetRenderScheduled = false;
    function scheduleFleetRender() {
        if (fleetRenderScheduled)
            return;
        fleetRenderScheduled = true;
        const defer = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
        defer(() => {
            fleetRenderScheduled = false;
            const container = document.getElementById('agy-google-account-pool-section');
            if (container?.isConnected)
                renderGoogleFleet();
        });
    }
    async function refreshFleetQuotas(force = false) {
        if (fleetRefreshing)
            return;
        const container = document.getElementById('agy-google-account-pool-section');
        if (!container?.isConnected || container.hidden)
            return;
        const members = fleetMembers(modelList);
        if (!members.length)
            return;
        fleetRefreshing = true;
        const refreshBtn = document.getElementById('agy-fleet-refresh-btn');
        if (refreshBtn) {
            refreshBtn.textContent = 'Refreshing…';
            refreshBtn.disabled = true;
        }
        try {
            const accountGroups = new Map();
            for (const m of members) {
                const id = m.account.id;
                if (!accountGroups.has(id)) {
                    accountGroups.set(id, { account: m.account, owner: m.owner, members: [] });
                }
                accountGroups.get(id).members.push(m);
            }
            const tasks = Array.from(accountGroups.values()).map(async ({ account, owner, members: groupMembers }) => {
                if (!container.isConnected)
                    return;
                const needsRefresh = force ||
                    groupMembers.some((m) => {
                        const key = quotaKey(m.owner, m.account);
                        return Date.now() - (quotaCache.get(key)?.at || 0) >= 120000;
                    });
                if (!needsRefresh)
                    return;
                try {
                    const result = (await electron_1.ipcRenderer.invoke('storage:google-test-account', {
                        modelName: owner.name,
                        accountId: account.id,
                    }));
                    requireSuccess(result);
                    for (const m of groupMembers) {
                        quotaCache.set(quotaKey(m.owner, m.account), { quota: result.quota, at: Date.now() });
                    }
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    for (const m of groupMembers) {
                        quotaCache.set(quotaKey(m.owner, m.account), { error: msg, at: Date.now() });
                    }
                }
                finally {
                    scheduleFleetRender();
                }
            });
            await Promise.allSettled(tasks);
        }
        finally {
            fleetRefreshing = false;
            const btn = document.getElementById('agy-fleet-refresh-btn');
            if (btn) {
                btn.textContent = 'Refresh quotas';
                btn.disabled = false;
            }
            if (container.isConnected)
                renderGoogleFleet();
        }
    }
    function renderGoogleFleet() {
        const container = document.getElementById('agy-google-account-pool-section');
        if (!container)
            return;
        const restoreScroll = captureScrollPosition(container);
        const rows = fleetAccounts(modelList);
        const hasGoogleModels = modelList.some((model) => model.provider === 'google-cloudcode');
        container.hidden = !hasGoogleModels;
        if (!hasGoogleModels) {
            container.replaceChildren();
            restoreScroll();
            return;
        }
        const keys = new Set(fleetMembers(modelList).map(({ account, owner }) => quotaKey(owner, account)));
        for (const key of quotaCache.keys())
            if (!keys.has(key))
                quotaCache.delete(key);
        function formatRelativeReset(resetTime) {
            if (!resetTime)
                return '';
            const parsed = Date.parse(resetTime);
            if (!Number.isFinite(parsed))
                return '';
            const diffMs = parsed - Date.now();
            if (diffMs <= 0)
                return 'Resets soon';
            const diffSec = Math.floor(diffMs / 1000);
            const days = Math.floor(diffSec / 86400);
            const hours = Math.floor((diffSec % 86400) / 3600);
            const mins = Math.floor((diffSec % 3600) / 60);
            if (days > 0)
                return `Resets in ${days}d ${hours}h`;
            if (hours > 0)
                return `Resets in ${hours}h ${mins}m`;
            return `Resets in ${mins}m`;
        }
        function formatBucketDisplayName(bucket) {
            if (bucket.displayName && !/claude|gpt|gemini/i.test(bucket.displayName))
                return bucket.displayName;
            if (bucket.id === 'weekly')
                return 'Weekly Limit Remaining';
            if (bucket.id === 'five_hour')
                return 'Five Hour Limit Remaining';
            if (bucket.id === 'daily')
                return 'Daily Limit Remaining';
            return bucket.displayName || bucket.id || 'Limit Remaining';
        }
        function formatBucketTitle(bucket) {
            const title = formatBucketDisplayName(bucket);
            const isThirdParty = /claude|gpt|anthropic|openai|third[- ]?party/i.test(`${bucket.groupName || ''} ${title} ${bucket.id || ''}`);
            const group = bucket.groupName || (isThirdParty ? 'Claude and GPT models' : 'Gemini Models');
            return [group, title].filter(Boolean).join(' · ');
        }
        const header = element('div', 'agy-toolbar agy-fleet-header');
        const titleWrapper = element('div', 'agy-fleet-title-wrapper');
        titleWrapper.setAttribute('role', 'button');
        titleWrapper.setAttribute('aria-expanded', String(!googleFleetCollapsed));
        titleWrapper.title = googleFleetCollapsed ? 'Click to expand Google account fleet' : 'Click to collapse Google account fleet';
        const chevron = element('span', 'agy-fleet-chevron', googleFleetCollapsed ? '▶' : '▼');
        const titleHeading = element('h3', '', `Google account fleet · ${rows.length} account${rows.length === 1 ? '' : 's'}`);
        titleWrapper.append(chevron, titleHeading);
        if (googleFleetCollapsed) {
            titleWrapper.append(element('span', 'agy-muted', '(Collapsed)'));
        }
        titleWrapper.onclick = () => {
            googleFleetCollapsed = !googleFleetCollapsed;
            try {
                localStorage.setItem('agy_google_fleet_collapsed', String(googleFleetCollapsed));
            }
            catch { }
            renderGoogleFleet();
        };
        header.append(titleWrapper);
        const actions = element('div', 'agy-actions');
        const targetPool = element('select');
        targetPool.id = 'agy-fleet-target-pool';
        targetPool.setAttribute('aria-label', 'Pool for new Google account');
        for (const model of modelList.filter((model) => model.provider === 'google-cloudcode')) {
            const option = element('option', '', model.displayName || model.name);
            option.value = model.name;
            targetPool.append(option);
        }
        actions.append(targetPool);
        const add = button('+ Add Account', () => connectFleetAccount(targetPool.value));
        add.id = 'agy-pool-add-account-btn';
        const fallbackToggle = element('label', 'agy-fleet-toggle');
        fallbackToggle.title = 'Automatically fail over native Google chat requests (429/403) to eligible fleet accounts';
        const fallbackInput = element('input');
        fallbackInput.type = 'checkbox';
        fallbackInput.id = 'agy-fleet-native-failover';
        fallbackInput.className = 'agy-switch-input';
        const isFallbackActive = modelList.some((m) => m.provider === 'google-cloudcode' && m.googlePool?.nativeFailoverEnabled === true);
        fallbackInput.checked = isFallbackActive;
        const switchTrack = element('span', 'agy-switch');
        const switchThumb = element('span', 'agy-switch-thumb');
        switchTrack.append(fallbackInput, switchThumb);
        const statusText = element('span', `agy-switch-status${isFallbackActive ? ' agy-switch-status-active' : ''}`, isFallbackActive ? 'Enabled' : 'Disabled');
        fallbackInput.onchange = async () => {
            const enabled = fallbackInput.checked;
            statusText.textContent = enabled ? 'Enabled' : 'Disabled';
            statusText.className = `agy-switch-status${enabled ? ' agy-switch-status-active' : ''}`;
            for (const m of modelList) {
                if (m.provider === 'google-cloudcode') {
                    const pool = (m.googlePool || {});
                    m.googlePool = { ...pool, nativeFailoverEnabled: enabled };
                    requireSuccess(await storageAPI.saveCustomModel(m));
                }
            }
            await modelsChanged();
        };
        fallbackToggle.append(element('span', 'agy-fleet-toggle-label', 'Native Google request fallback'), switchTrack, statusText);
        const refreshBtn = button(fleetRefreshing ? 'Refreshing…' : 'Refresh quotas', async () => {
            await refreshFleetQuotas(true);
        });
        refreshBtn.id = 'agy-fleet-refresh-btn';
        if (fleetRefreshing)
            refreshBtn.disabled = true;
        actions.append(add, refreshBtn, fallbackToggle);
        header.append(actions);
        const wrap = element('div', 'agy-fleet-table-wrap');
        const table = element('table', 'agy-fleet-table');
        const head = element('thead');
        const heading = element('tr');
        for (const title of ['Account & Quotas', 'Assigned model pools'])
            heading.append(element('th', '', title));
        head.append(heading);
        table.append(head);
        const tbody = element('tbody');
        for (const { identity: accountIdentity, members } of rows) {
            const row = element('tr');
            row.dataset.accountIdentity = accountIdentity;
            const isAccountEnabled = members.some(({ account }) => account.enabled !== false);
            const accountCached = members.map(({ account, owner }) => quotaCache.get(quotaKey(owner, account))).find((c) => c?.quota?.buckets?.length) ||
                members.map(({ account, owner }) => quotaCache.get(quotaKey(owner, account))).find(Boolean);
            const card = element('div', `agy-fleet-card${!isAccountEnabled ? ' agy-card-disabled' : ''}`);
            // 1. Header row: Account label, badge, model count on left; Action buttons permanently fixed on right
            const cardHeader = element('div', 'agy-fleet-card-header');
            const headerInfo = element('div', 'agy-fleet-card-header-info');
            const statusBadge = !isAccountEnabled
                ? element('div', 'agy-pool-badge agy-pool-disabled', 'Disabled')
                : accountCached?.quota?.planTier
                    ? element('div', `agy-pool-badge${accountCached.quota.planTier.toLowerCase() === 'pro' ? ' agy-badge-pro' : ''}`, accountCached.quota.planTier)
                    : element('div', 'agy-pool-badge', 'Free');
            headerInfo.append(element('div', 'agy-fleet-label', accountIdentity), statusBadge, element('div', 'agy-muted', `${members.length} model pool${members.length === 1 ? '' : 's'}`));
            const accountActions = element('div', 'agy-actions agy-fleet-account-actions');
            let accountActive = isAccountEnabled;
            const toggleBtn = button(accountActive ? 'Disable' : 'Enable', async () => {
                const nextState = !accountActive;
                accountActive = nextState;
                // 1. Instant in-place UI update (ZERO layout shift or scroll jump)
                toggleBtn.textContent = nextState ? 'Disable' : 'Enable';
                toggleBtn.classList.toggle('agy-primary', !nextState);
                card.classList.toggle('agy-card-disabled', !nextState);
                statusBadge.className = !nextState
                    ? 'agy-pool-badge agy-pool-disabled'
                    : accountCached?.quota?.planTier
                        ? `agy-pool-badge${accountCached.quota.planTier.toLowerCase() === 'pro' ? ' agy-badge-pro' : ''}`
                        : 'agy-pool-badge';
                statusBadge.textContent = !nextState ? 'Disabled' : (accountCached?.quota?.planTier || 'Free');
                // Update pool badges and choose buttons inside this card in-place:
                for (const poolEl of card.querySelectorAll('.agy-fleet-pool')) {
                    const badge = poolEl.querySelector('.agy-pool-badge');
                    const chooseBtn = poolEl.querySelector('.agy-pool-actions button');
                    if (badge) {
                        if (!nextState) {
                            badge.className = 'agy-pool-badge agy-pool-disabled';
                            badge.textContent = 'Disabled';
                        }
                        else {
                            const modelName = poolEl.dataset.modelName;
                            const acctId = poolEl.dataset.accountId;
                            const model = modelList.find((m) => m.name === modelName);
                            const isPref = model?.googlePool?.preferredAccountId === acctId;
                            badge.className = `agy-pool-badge${isPref ? ' agy-pool-preferred' : ''}`;
                            badge.textContent = isPref ? 'Preferred' : 'Automatic';
                        }
                    }
                    if (chooseBtn && (chooseBtn.textContent?.includes('preferred') || chooseBtn?.textContent === 'Automatic')) {
                        chooseBtn.disabled = !nextState;
                    }
                }
                // 2. Persist to storage
                for (const { owner, account } of members) {
                    const currentAccounts = Array.isArray(owner.googleAccounts) ? owner.googleAccounts : [];
                    const updatedAccounts = currentAccounts.map((a) => {
                        if (a.id === account.id)
                            return { ...a, enabled: nextState };
                        return a;
                    });
                    const anyAccountEnabled = updatedAccounts.some((a) => a.enabled !== false);
                    const updatedModel = {
                        ...owner,
                        enabled: anyAccountEnabled ? nextState : false,
                        googleAccounts: updatedAccounts,
                    };
                    account.enabled = nextState;
                    owner.enabled = updatedModel.enabled;
                    requireSuccess(await storageAPI.saveCustomModel(updatedModel));
                }
                // 3. Update custom model rows below in-place:
                for (const { owner } of members) {
                    const row = document.querySelector(`#agy-custom-models-content [data-model-name="${owner.name}"]`);
                    if (row) {
                        row.dataset.enabled = String(owner.enabled !== false);
                    }
                }
            });
            if (!isAccountEnabled) {
                toggleBtn.classList.add('agy-primary');
            }
            const editBtn = button('Edit', () => {
                openEditFleetAccountModal(accountIdentity, members);
            });
            const removeBtn = button('Remove account', () => {
                const { body, status, close } = openModal('Remove Google account');
                const modelNames = members.map((m) => m.owner.displayName || m.owner.name).join(', ');
                body.append(element('p', '', `Are you sure you want to remove account "${accountIdentity}" and all its assigned model pools (${modelNames})?`), element('p', 'agy-muted', 'All models configured for this account will be completely removed. This action cannot be undone.'));
                const modalActions = element('div', 'agy-actions');
                modalActions.append(button('Cancel', close), button('Remove account and models', async () => {
                    setStatus(status, 'Removing account and models…');
                    for (const { owner, account } of members) {
                        const currentAccounts = Array.isArray(owner.googleAccounts) ? owner.googleAccounts : [];
                        const remainingAccounts = currentAccounts.filter((a) => a.id !== account.id);
                        if (remainingAccounts.length > 0) {
                            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-remove-account', { modelName: owner.name, accountId: account.id }));
                        }
                        else {
                            requireSuccess(await storageAPI.deleteCustomModel(owner.name));
                        }
                    }
                    quotaCache.clear();
                    close();
                    await modelsChanged();
                }, status, true));
                body.append(modalActions);
            });
            accountActions.append(toggleBtn, editBtn, removeBtn);
            cardHeader.append(headerInfo, accountActions);
            card.append(cardHeader);
            // 2. Full-Width Quotas section
            const accountQuotas = element('div', 'agy-fleet-account-quotas');
            const allBuckets = [];
            const seenBucketIds = new Set();
            for (const { account, owner } of members) {
                const c = quotaCache.get(quotaKey(owner, account));
                if (Array.isArray(c?.quota?.groups) && c.quota.groups.length > 0) {
                    for (const g of c.quota.groups) {
                        const groupName = g.displayName || g.name || 'Models';
                        for (const b of g.buckets || []) {
                            const bWithGroup = { ...b, groupName: b.groupName || groupName };
                            const key = `${groupName}::${b.id || ''}::${b.displayName || ''}`;
                            if (!seenBucketIds.has(key)) {
                                seenBucketIds.add(key);
                                allBuckets.push(bWithGroup);
                            }
                        }
                    }
                }
                else if (Array.isArray(c?.quota?.buckets)) {
                    for (const b of c.quota.buckets) {
                        const isThirdParty = /claude|gpt|anthropic|openai|third[- ]?party/i.test(`${b.groupName || ''} ${b.displayName || ''} ${b.id || ''}`);
                        const groupName = b.groupName || (isThirdParty ? 'Claude and GPT models' : 'Gemini Models');
                        const key = `${groupName}::${b.id || ''}::${b.displayName || ''}`;
                        if (!seenBucketIds.has(key)) {
                            seenBucketIds.add(key);
                            allBuckets.push({ ...b, groupName });
                        }
                    }
                }
            }
            if (accountCached?.error) {
                accountQuotas.append(element('div', 'agy-status agy-error', accountCached.error));
            }
            else if (!accountCached) {
                accountQuotas.append(element('span', 'agy-muted', 'Loading quota…'));
            }
            else if (!allBuckets.length) {
                accountQuotas.append(element('span', 'agy-muted', 'Quota unavailable — Google returned no buckets.'));
            }
            else {
                const sections = new Map();
                for (const bucket of allBuckets) {
                    const isThirdParty = /claude|gpt|anthropic|openai|third[- ]?party/i.test(`${bucket.groupName || ''} ${bucket.displayName || ''} ${bucket.id || ''}`);
                    const sectionTitle = bucket.groupName && /gemini/i.test(bucket.groupName)
                        ? 'Gemini Models'
                        : isThirdParty
                            ? 'Claude and GPT models'
                            : (bucket.groupName || 'Gemini Models');
                    const list = sections.get(sectionTitle) || [];
                    list.push(bucket);
                    sections.set(sectionTitle, list);
                }
                const canonicalGroupOrder = ['gemini models', 'claude and gpt models'];
                const sortedSectionTitles = Array.from(sections.keys()).sort((a, b) => {
                    const idxA = canonicalGroupOrder.indexOf(a.toLowerCase().trim());
                    const idxB = canonicalGroupOrder.indexOf(b.toLowerCase().trim());
                    if (idxA !== -1 && idxB !== -1)
                        return idxA - idxB;
                    if (idxA !== -1)
                        return -1;
                    if (idxB !== -1)
                        return 1;
                    return a.localeCompare(b);
                });
                for (const sectionTitle of sortedSectionTitles) {
                    const buckets = sections.get(sectionTitle) || [];
                    const bucketOrder = (b) => {
                        const text = `${b.displayName || ''} ${b.id || ''}`.toLowerCase();
                        if (text.includes('weekly'))
                            return 1;
                        if (text.includes('five') || text.includes('5[-_ ]?hour') || text.includes('hour'))
                            return 2;
                        if (text.includes('daily') || text.includes('day'))
                            return 3;
                        return 4;
                    };
                    buckets.sort((a, b) => bucketOrder(a) - bucketOrder(b));
                    const sectionEl = element('div', 'agy-quota-section');
                    sectionEl.append(element('div', 'agy-quota-section-title', sectionTitle));
                    for (const bucket of buckets) {
                        const block = element('div', 'agy-quota-bucket');
                        const fraction = bucket.remainingFraction;
                        const known = typeof fraction === 'number' && Number.isFinite(fraction);
                        const isExhausted = known && fraction === 0;
                        const bName = formatBucketDisplayName(bucket);
                        const pctText = known ? `${Math.round(fraction * 100)}% remaining` : 'Quota unknown';
                        const headerRow = element('div', 'agy-quota-bucket-header');
                        headerRow.append(element('span', 'agy-quota-bucket-name', bName), element('span', `agy-quota-bucket-pct${isExhausted ? ' exhausted' : ''}`, pctText));
                        block.append(headerRow);
                        if (known) {
                            const bar = element('progress');
                            bar.max = 1;
                            bar.value = Math.max(0, Math.min(1, fraction));
                            if (isExhausted)
                                bar.className = 'exhausted';
                            bar.setAttribute('aria-label', `${sectionTitle} ${bName} quota`);
                            block.append(bar);
                        }
                        if (bucket.resetTime) {
                            const relReset = formatRelativeReset(bucket.resetTime);
                            if (relReset)
                                block.append(element('div', 'agy-quota-reset', relReset));
                        }
                        sectionEl.append(block);
                    }
                    accountQuotas.append(sectionEl);
                }
            }
            card.append(accountQuotas);
            // 3. Assigned model pools section (responsive grid)
            const poolsSection = element('div', 'agy-fleet-pools-section');
            poolsSection.append(element('div', 'agy-fleet-pools-heading', `Assigned model pools (${members.length})`));
            const poolsGrid = element('div', 'agy-fleet-pools-grid');
            for (const { account, owner } of members) {
                const pool = element('section', 'agy-fleet-pool');
                pool.setAttribute('role', 'group');
                pool.setAttribute('aria-label', `${owner.displayName || owner.name} account ${account.id}`);
                pool.dataset.modelName = owner.name;
                pool.dataset.accountId = account.id;
                const preferred = owner.googlePool?.preferredAccountId === account.id;
                const enabled = owner.enabled !== false && account.enabled !== false;
                const poolInfo = element('div', 'agy-pool-info');
                const titleRow = element('div', 'agy-pool-title-row');
                const poolBadge = element('span', `agy-pool-badge${!enabled ? ' agy-pool-disabled' : preferred ? ' agy-pool-preferred' : ''}`, !enabled ? 'Disabled' : preferred ? 'Preferred' : 'Automatic');
                titleRow.append(element('span', 'agy-pool-name', owner.displayName || owner.name), poolBadge);
                const metaRow = element('div', 'agy-pool-meta', [
                    owner.name,
                    account.project ? `Project: ${account.project}` : '',
                ].filter(Boolean).join(' · '));
                poolInfo.append(titleRow, metaRow);
                const rowActions = element('div', 'agy-actions agy-pool-actions');
                let isPreferred = preferred;
                const choose = button(isPreferred ? 'Automatic' : 'Use preferred', async () => {
                    const nextPreferred = !isPreferred;
                    isPreferred = nextPreferred;
                    // 1. Instant in-place UI update (ZERO layout shift or scroll jump)
                    choose.textContent = nextPreferred ? 'Automatic' : 'Use preferred';
                    choose.classList.toggle('agy-primary', nextPreferred);
                    poolBadge.className = `agy-pool-badge${nextPreferred ? ' agy-pool-preferred' : ''}`;
                    poolBadge.textContent = nextPreferred ? 'Preferred' : 'Automatic';
                    if (nextPreferred) {
                        for (const otherPool of document.querySelectorAll(`.agy-fleet-pool[data-model-name="${owner.name}"]`)) {
                            if (otherPool !== pool) {
                                const otherBadge = otherPool.querySelector('.agy-pool-badge');
                                const otherBtn = otherPool.querySelector('.agy-pool-actions button');
                                if (otherBadge && otherBadge.textContent === 'Preferred') {
                                    otherBadge.className = 'agy-pool-badge';
                                    otherBadge.textContent = 'Automatic';
                                }
                                if (otherBtn && otherBtn.textContent === 'Automatic') {
                                    otherBtn.textContent = 'Use preferred';
                                    otherBtn.classList.remove('agy-primary');
                                }
                            }
                        }
                    }
                    // 2. Update in-memory model
                    if (owner.googlePool) {
                        if (nextPreferred) {
                            owner.googlePool.preferredAccountId = account.id;
                        }
                        else {
                            delete owner.googlePool.preferredAccountId;
                        }
                    }
                    else if (nextPreferred) {
                        owner.googlePool = { preferredAccountId: account.id };
                    }
                    // 3. Persist to backend via IPC
                    requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-select-account', { modelName: owner.name, accountId: account.id }));
                });
                if (isPreferred) {
                    choose.classList.add('agy-primary');
                }
                choose.disabled = !enabled;
                rowActions.append(choose, account.authMode === 'antigravity' ? button('Reconnect', () => connectFleetAccount(owner.name, account.id)) : button('Edit account', () => openModelModal(owner)), button('Remove', () => removeFleetAccount(account, owner.name)));
                pool.append(poolInfo, rowActions);
                const cached = quotaCache.get(quotaKey(owner, account));
                for (const bucket of cached?.quota?.buckets || []) {
                    const fraction = bucket.remainingFraction;
                    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
                        const bar = element('progress');
                        bar.hidden = true;
                        bar.style.display = 'none';
                        bar.max = 1;
                        bar.value = Math.max(0, Math.min(1, fraction));
                        pool.append(bar);
                        break;
                    }
                }
                poolsGrid.append(pool);
            }
            poolsSection.append(poolsGrid);
            card.append(poolsSection);
            const cell = element('td', 'agy-fleet-card-cell');
            cell.colSpan = 2;
            cell.append(card);
            row.append(cell);
            tbody.append(row);
        }
        table.append(tbody);
        wrap.append(table);
        const fleetBody = element('div', 'agy-fleet-body');
        if (googleFleetCollapsed) {
            fleetBody.hidden = true;
            fleetBody.style.display = 'none';
        }
        fleetBody.append(element('p', 'agy-muted', 'Accounts are grouped by email when available. Each model pool keeps its own credentials, project and reported quotas. Preferred accounts are used when eligible; unknown limits are not available credit.'), wrap);
        const prevHeight = container.offsetHeight;
        if (prevHeight > 0)
            container.style.minHeight = `${prevHeight}px`;
        container.replaceChildren(header, fleetBody);
        restoreScroll();
        requestAnimationFrame(() => {
            container.style.minHeight = '';
            restoreScroll();
        });
    }
    async function renderCustomModelsList(autoRefreshQuotas = false) {
        const target = document.getElementById('agy-custom-models-content');
        if (!target)
            return;
        const version = ++renderVersion;
        try {
            const models = await storageAPI.getCustomModels();
            if (version !== renderVersion || !target.isConnected)
                return;
            const restoreScroll = captureScrollPosition(target);
            modelList = models;
            renderGoogleFleet();
            if (autoRefreshQuotas)
                void refreshFleetQuotas();
            const content = document.createDocumentFragment();
            const groups = new Map();
            for (const model of models) {
                if (searchTerm &&
                    !`${model.displayName} ${model.name} ${model.externalModelName} ${model.provider}`
                        .toLowerCase()
                        .includes(searchTerm))
                    continue;
                const key = `${model.provider}\n${model.apiUrl}`;
                groups.set(key, [...(groups.get(key) || []), model]);
            }
            if (!groups.size)
                content.append(element('p', 'agy-muted', models.length
                    ? 'No models match this search.'
                    : 'Add a provider model, discover a local server, or import a configuration to get started.'));
            for (const models of groups.values()) {
                const first = models[0];
                const group = element('section', 'agy-group');
                const header = element('div', 'agy-group-heading');
                const heading = element('div');
                heading.append(element('h3', '', `${first.provider} · ${models.filter((model) => model.enabled !== false).length}/${models.length} enabled`), element('div', 'agy-muted', first.apiUrl));
                const groupStatus = statusNode();
                const actions = element('div', 'agy-actions');
                actions.append(button('Discover models', () => openModelModal(first, 'discover'), groupStatus));
                const allEnabled = models.every((model) => model.enabled !== false);
                actions.append(button(allEnabled ? 'Disable group' : 'Enable group', async () => {
                    for (const model of models)
                        requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !allEnabled }));
                    await modelsChanged();
                }, groupStatus));
                header.append(heading, actions);
                group.append(header, groupStatus);
                for (const model of models) {
                    const row = element('div', 'agy-row');
                    row.dataset.modelName = model.name;
                    row.dataset.enabled = String(model.enabled !== false);
                    const info = element('div', 'agy-row-info');
                    info.append(element('strong', '', model.displayName || model.name), element('div', 'agy-muted', model.externalModelName));
                    if (model.nativePickerAvailable === false)
                        info.append(element('div', 'agy-muted', typeof model.nativePickerError === 'string' ? model.nativePickerError :
                            'Not currently available in the native model picker. Direct API access remains available.'));
                    const rowStatus = statusNode();
                    info.append(rowStatus);
                    const actions = element('div', 'agy-actions');
                    actions.append(button(model.enabled === false ? 'Enable' : 'Disable', async () => {
                        requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: model.enabled === false }));
                        await modelsChanged();
                    }, rowStatus), button('Test', async () => {
                        setStatus(rowStatus, 'Testing…');
                        const result = requireSuccess(await storageAPI.testModelConnection(model));
                        setStatus(rowStatus, result.message || 'Connection successful.');
                    }, rowStatus), button('Test generation', () => openGenerationTest(model), rowStatus), button('Edit', () => openModelModal(model, 'edit'), rowStatus), button('Duplicate', () => openModelModal(model, 'duplicate'), rowStatus), ...(model.supportsThinking === false
                        ? []
                        : [
                            button('Effort variants', () => {
                                const { body, status, close } = openModal('Create reasoning variants');
                                body.append(element('p', 'agy-muted', 'Creates three copies with low, medium and high reasoning effort. The provider must support reasoning. For Google and Anthropic formats the thinking budgets are 1,024 / 4,096 / 8,192 tokens; output limits increase if needed to fit the budget. Existing models and credentials are preserved.'));
                                body.append(button('Create three variants', async () => {
                                    requireSuccess(await electron_1.ipcRenderer.invoke('storage:create-effort-variants', model.name));
                                    close();
                                    await modelsChanged();
                                }, status, true));
                            }, rowStatus),
                        ]), button('Delete', () => openDeleteModelModal(model), rowStatus));
                    row.append(info, actions);
                    group.append(row);
                }
                content.append(group);
            }
            target.replaceChildren(content);
            restoreScroll();
        }
        catch (error) {
            setStatus(target, error instanceof Error ? error.message : 'Could not load custom models.', true);
        }
    }
    async function openModelModal(existing, mode = 'edit') {
        const { body, status, close } = openModal(mode === 'duplicate'
            ? 'Duplicate model'
            : mode === 'discover'
                ? 'Discover provider models'
                : existing
                    ? 'Edit model'
                    : 'Add custom model');
        try {
            const presets = await storageAPI.getPresets();
            if (!body.isConnected)
                return;
            const providers = [...presets];
            if (existing && !providers.some((preset) => preset.id === existing.provider))
                providers.push({
                    id: existing.provider,
                    label: existing.provider,
                    defaultUrl: existing.apiUrl,
                    apiFormat: existing.apiFormat || 'openai',
                    keyRequired: false,
                });
            if (!providers.length)
                throw new Error('Provider presets are unavailable. Close this dialog and try again.');
            const provider = selectField(body, 'Provider', 'agy-provider', providers.map((preset) => [preset.id, preset.label]), existing?.provider || providers[0].id);
            const preset = () => providers.find((value) => value.id === provider.value) || providers[0];
            const apiUrl = field(body, 'API URL', 'agy-api-url', existing?.apiUrl || preset().defaultUrl, 'url');
            const workersHint = element('p', 'agy-muted', 'Cloudflare: replace ACCOUNT_ID in the API URL with your 32-character Account ID. Use the Workers AI API token template, or keep your existing authentication headers. Model discovery verifies catalog access; generation is not tested.');
            body.append(workersHint);
            function workersConnection() {
                if (provider.value === 'workers-ai')
                    return true;
                try {
                    const url = new URL(apiUrl.value);
                    return url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\//.test(url.pathname);
                }
                catch {
                    return false;
                }
            }
            const updateWorkersHint = () => {
                workersHint.hidden = !workersConnection();
            };
            apiUrl.addEventListener('input', updateWorkersHint);
            updateWorkersHint();
            const apiKey = field(body, 'API key', 'agy-api-key', existing?.apiKey === 'none' ? '' : existing?.apiKey || '', 'password');
            apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
            const opencodeAuth = selectField(body, 'OpenCode authentication', 'agy-opencode-auth', [['auth', 'API key'], ['noAuth', 'Keyless request']], existing?.apiKey && existing.apiKey !== 'none' ? 'auth' : 'noAuth');
            const opencodeHint = element('p', 'agy-muted', 'OpenCode may restrict keyless free models to its own app. If the service rejects this client, add an API key or choose another model/provider.');
            body.append(opencodeHint);
            const isOpencode = () => ['opencode', 'zen'].includes(provider.value) || (() => {
                try {
                    const url = new URL(apiUrl.value);
                    return url.origin === 'https://opencode.ai' && !/\/(?:zen|inference)\/go\//.test(url.pathname);
                }
                catch {
                    return false;
                }
            })();
            const keylessOpencode = () => isOpencode() && opencodeAuth.value === 'noAuth';
            const updateOpencodeAuth = () => {
                opencodeAuth.closest('label').hidden = !isOpencode();
                opencodeHint.hidden = !isOpencode();
                apiKey.closest('label').hidden = provider.value === 'google-cloudcode' || keylessOpencode();
            };
            opencodeAuth.addEventListener('change', updateOpencodeAuth);
            apiUrl.addEventListener('input', updateOpencodeAuth);
            updateOpencodeAuth();
            const apiFormat = selectField(body, 'API format', 'agy-api-format', [
                ['openai', 'OpenAI compatible'],
                ['anthropic', 'Anthropic Messages'],
                ['google', 'Google Gemini'],
            ], existing?.apiFormat || preset().apiFormat);
            const grid = element('div', 'agy-grid');
            const modelId = field(grid, 'Provider model ID', 'agy-model-id', mode === 'discover' ? '' : existing?.externalModelName || '');
            const displayName = field(grid, 'Display name', 'agy-display-name', mode === 'duplicate'
                ? `${existing?.displayName || existing?.externalModelName || ''} copy`
                : mode === 'discover'
                    ? ''
                    : existing?.displayName || '');
            body.append(grid);
            const name = field(body, 'Configuration name (unique)', 'agy-model-name', mode === 'duplicate' ? uniqueName(`${existing?.name}-copy`) : mode === 'discover' ? '' : existing?.name || '');
            name.placeholder = 'Generated from provider and model ID when left blank';
            const description = field(body, 'Description', 'agy-description', String(existing?.description || ''));
            const googleConfig = element('div');
            googleConfig.id = 'agy-google-account-config';
            const googleProject = field(googleConfig, 'Default Cloud Code project (optional)', 'agy-google-project', String(existing?.googleProject || ''));
            const initialPool = existing?.googlePool;
            const poolGrid = element('div', 'agy-grid');
            const poolStrategy = selectField(poolGrid, 'Account selection', 'agy-google-pool-strategy', [
                ['round-robin', 'Round robin'],
                ['least-loaded', 'Least loaded'],
                ['quota', 'Remaining quota'],
                ['adaptive', 'Adaptive health and load'],
            ], initialPool?.strategy || 'least-loaded');
            const poolConcurrency = field(poolGrid, 'Maximum requests per account', 'agy-google-pool-concurrency', String(initialPool?.maxConcurrency || 2), 'number');
            const poolCooldown = field(poolGrid, 'Account cooldown (milliseconds)', 'agy-google-pool-cooldown', String(initialPool?.cooldownMs || 60000), 'number');
            const nativeFailover = selectField(poolGrid, 'Native Google request fallback', 'agy-google-native-failover', [['false', 'Off'], ['true', 'Use this pool for matching native models']], String(initialPool?.nativeFailoverEnabled === true));
            googleConfig.append(poolGrid);
            googleConfig.append(element('p', 'agy-muted', 'Optional fallback uses this saved Google account pool only when a native request for the exact provider model fails. It does not change your signed-in IDE account.'));
            const readAccounts = createGoogleAccountPanel(googleConfig, Array.isArray(existing?.googleAccounts) ? existing.googleAccounts : [], existing?.name);
            const updateGoogleVisibility = () => {
                const isGoogle = provider.value === 'google-cloudcode';
                googleConfig.hidden = !isGoogle;
                updateOpencodeAuth();
                apiFormat.closest('label').hidden = isGoogle;
            };
            updateGoogleVisibility();
            body.append(googleConfig);
            const advanced = element('details');
            advanced.append(element('summary', '', 'Advanced settings'));
            const advancedGrid = element('div', 'agy-grid');
            const effort = selectField(advancedGrid, 'Reasoning effort', 'agy-reasoning-effort', ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => [
                value,
                value || 'Provider default',
            ]), String(existing?.reasoningEffort || ''));
            const thinking = field(advancedGrid, 'Thinking budget (tokens)', 'agy-thinking-budget', existing?.thinkingBudget != null ? String(existing.thinkingBudget) : '', 'number');
            const compactionEffort = selectField(advancedGrid, 'Compaction reasoning effort', 'agy-compaction-effort', ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => [
                value,
                value || 'Use normal model settings',
            ]), String(existing?.compactionReasoningEffort || ''));
            advancedGrid.append(element('p', 'agy-muted', 'Only recognized IDE continuation summaries use this effort. Choose low for faster summaries, or none if your model supports disabling reasoning. Normal chat keeps its settings.'));
            const maxOutput = field(advancedGrid, 'Maximum output tokens', 'agy-max-output', existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '', 'number');
            const context = field(advancedGrid, 'Context window (tokens)', 'agy-context-window', existing?.contextWindow != null ? String(existing.contextWindow) : '', 'number');
            const compactionThreshold = field(advancedGrid, 'IDE compaction threshold (%)', 'agy-compaction-threshold', existing?.compactionThresholdPercent != null ? String(existing.compactionThresholdPercent) : '', 'number');
            compactionThreshold.min = '10';
            compactionThreshold.max = '90';
            compactionThreshold.placeholder = 'IDE default';
            advancedGrid.append(element('p', 'agy-muted', 'Optional, 10–90% of the actual context window in new tokens since the previous checkpoint. Native counts may differ from provider totals. With many tools, start at 50%; higher values can trim older history before a full checkpoint. Leave blank for IDE defaults. The threshold is capped to reserve the model output limit plus 1,024 tokens. Set accurate context and output limits, then fully quit and reopen the IDE; the model cache may take an additional turn to refresh.'));
            advancedGrid.append(element('p', 'agy-muted', 'IDE 2.5.5 needs at least 50,000 input tokens after those reserves. Its native picker may show a compatibility context, for example 90,000 for a real 85,000-token model. Your saved context and provider limit remain 85,000 in that example, and the custom checkpoint policy uses that real limit.'));
            const timeout = field(advancedGrid, 'Request timeout (milliseconds)', 'agy-timeout', existing?.timeout != null ? String(existing.timeout) : '', 'number');
            const retries = field(advancedGrid, 'Maximum retries (0–5)', 'agy-max-retries', existing?.maxRetries != null ? String(existing.maxRetries) : '', 'number');
            retries.max = '5';
            const vision = selectField(advancedGrid, 'Image input', 'agy-vision', [
                ['', 'Auto detect'],
                ['true', 'Supported'],
                ['false', 'Unsupported'],
            ], existing?.supportsVision == null ? '' : String(existing.supportsVision));
            const rawUrl = selectField(advancedGrid, 'Endpoint path', 'agy-raw-url', [
                ['false', 'Normalize for provider'],
                ['true', 'Use exactly as entered'],
            ], String(existing?.rawUrl === true));
            const tls = selectField(advancedGrid, 'TLS certificates', 'agy-tls', [
                ['false', 'Verify certificates'],
                ['true', 'Allow self-signed certificates'],
            ], String(existing?.allowUnauthorized === true));
            const enabled = selectField(advancedGrid, 'Model state', 'agy-enabled', [
                ['true', 'Enabled'],
                ['false', 'Disabled'],
            ], String(existing?.enabled !== false));
            advanced.append(advancedGrid);
            const fallbacks = field(advanced, 'Fallback model configuration names (comma separated)', 'agy-fallback-models', Array.isArray(existing?.fallbackModels) ? existing.fallbackModels.join(', ') : '');
            const headers = jsonField(advanced, 'Custom headers (JSON)', 'agy-custom-headers', existing?.customHeaders);
            const extraBody = jsonField(advanced, 'Additional request fields (JSON)', 'agy-extra-body', existing?.extraBody);
            const breaker = existing?.circuitBreaker;
            const breakerGrid = element('div', 'agy-grid');
            const breakerEnabled = selectField(breakerGrid, 'Circuit breaker', 'agy-breaker-enabled', [
                ['', 'Default'],
                ['true', 'Enabled'],
                ['false', 'Disabled'],
            ], breaker?.enabled == null ? '' : String(breaker.enabled));
            const breakerThreshold = field(breakerGrid, 'Failures before cooldown', 'agy-breaker-threshold', breaker?.failureThreshold != null ? String(breaker.failureThreshold) : '', 'number');
            const breakerCooldown = field(breakerGrid, 'Cooldown (milliseconds)', 'agy-breaker-cooldown', breaker?.cooldownMs != null ? String(breaker.cooldownMs) : '', 'number');
            advanced.append(breakerGrid);
            body.append(advanced);
            const discovery = element('div', 'agy-discovery');
            const discoveryFilter = element('div');
            discoveryFilter.hidden = true;
            const discoverySearch = field(discoveryFilter, 'Search provider models', 'agy-discovery-search', '', 'search');
            discoverySearch.placeholder = 'Filter by model name or ID';
            discoverySearch.addEventListener('input', () => showChoices());
            let choices = [];
            const selected = new Set();
            function hasWorkersAuthentication(customHeaders) {
                const authentication = Object.fromEntries(Object.entries(customHeaders || {}).map(([key, value]) => [
                    key.toLowerCase(),
                    typeof value === 'string' ? value.trim() : '',
                ]));
                return !!((apiKey.value.trim() && apiKey.value.trim() !== 'none') ||
                    authentication.authorization ||
                    (authentication['x-auth-key'] && authentication['x-auth-email']));
            }
            function connection() {
                const endpoint = validUrl(apiUrl.value);
                const customHeaders = readJson(headers, 'Custom headers');
                if (workersConnection()) {
                    if (!/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(new URL(endpoint).pathname))
                        throw new Error('Replace ACCOUNT_ID in the Cloudflare API URL with your 32-character Account ID.');
                    if (apiFormat.value !== 'openai')
                        throw new Error('Cloudflare Workers AI requires the OpenAI compatible API format.');
                    if (!hasWorkersAuthentication(customHeaders))
                        throw new Error('Enter a Cloudflare Workers AI API token or authentication headers.');
                }
                return {
                    provider: provider.value,
                    apiUrl: endpoint,
                    apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
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
                                ...initialPool,
                                preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                                strategy: poolStrategy.value,
                                nativeFailoverEnabled: nativeFailover.value === 'true',
                                maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                                cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                            },
                        }
                        : {}),
                };
            }
            function modelConfig(id, title, localName) {
                if (!id.trim() || /\s/.test(id.trim()))
                    throw new Error('Enter a model ID without spaces.');
                if (preset().keyRequired && !keylessOpencode() && !apiKey.value.trim() && !workersConnection())
                    throw new Error('Enter an API key for this provider.');
                if (provider.value === 'google-cloudcode' && !readAccounts().some((account) => account.enabled !== false))
                    throw new Error('Add and enable at least one Google account.');
                const maxRetries = readNumber(retries, 'Maximum retries');
                if (maxRetries != null && maxRetries > 5)
                    throw new Error('Maximum retries cannot exceed 5.');
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
                    apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
                    externalModelName: id.trim(),
                    displayName: title || id.trim(),
                    description: description.value.trim(),
                    enabled: enabled.value === 'true',
                    apiFormat: apiFormat.value,
                    googleAccounts: provider.value === 'google-cloudcode' ? readAccounts() : undefined,
                    googleProject: provider.value === 'google-cloudcode' ? googleProject.value.trim() || undefined : undefined,
                    googlePool: provider.value === 'google-cloudcode'
                        ? {
                            ...initialPool,
                            preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                            strategy: poolStrategy.value,
                            nativeFailoverEnabled: nativeFailover.value === 'true',
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
                    circuitBreaker: breakerEnabled.value || breakerThreshold.value || breakerCooldown.value
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
            function showChoices() {
                discovery.replaceChildren();
                discoveryFilter.hidden = !choices.length;
                if (!choices.length)
                    return;
                const query = discoverySearch.value.trim().toLowerCase();
                const visible = choices.filter((model) => `${model.displayName || ''} ${model.id}`.toLowerCase().includes(query));
                const toolbar = element('div', 'agy-actions');
                const count = element('span', 'agy-muted', `${visible.length} of ${choices.length} models · ${selected.size} selected`);
                toolbar.append(count, button(query ? 'Select filtered' : 'Select all', () => {
                    for (const model of visible)
                        selected.add(model.id);
                    showChoices();
                }, status), button('Clear selection', () => {
                    selected.clear();
                    showChoices();
                }, status));
                discovery.append(toolbar);
                if (!visible.length)
                    discovery.append(element('p', 'agy-muted', 'No provider models match this search.'));
                for (const model of visible) {
                    const label = element('label', 'agy-choice');
                    const checkbox = element('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = selected.has(model.id);
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked)
                            selected.add(model.id);
                        else
                            selected.delete(model.id);
                        count.textContent = `${visible.length} of ${choices.length} models · ${selected.size} selected`;
                    });
                    label.append(checkbox, element('span', '', model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id));
                    discovery.append(label);
                }
            }
            const actions = element('div', 'agy-actions');
            actions.append(button('Test connection', async () => {
                setStatus(status, 'Testing…');
                const result = requireSuccess(await storageAPI.testModelConnection(connection()));
                setStatus(status, result.message || 'Connection successful.');
            }, status), button('Test generation (may incur charges)', async () => {
                setStatus(status, 'Sending a short generation test…');
                const result = requireSuccess(await storageAPI.testModelGeneration(connection()));
                setStatus(status, result.message || 'Generation succeeded.');
            }, status), button('Fetch provider models', async () => {
                setStatus(status, 'Fetching models…');
                const result = await storageAPI.discoverModels(connection());
                requireSuccess(result);
                choices = result.models || [];
                discoverySearch.value = '';
                selected.clear();
                showChoices();
                setStatus(status, choices.length
                    ? 'Select models below, then choose Add selected.'
                    : 'This provider returned no models. You can enter a model ID manually.');
            }, status), button('Save model', async () => {
                requireSuccess(await storageAPI.saveCustomModel(modelConfig(modelId.value, displayName.value.trim())));
                await modelsChanged();
                close();
            }, status, true));
            body.append(actions, discoveryFilter, discovery);
            body.append(button('Add selected', async () => {
                if (!selected.size)
                    throw new Error('Select at least one model from the fetched list.');
                let saved = 0;
                for (const choice of choices.filter((model) => selected.has(model.id))) {
                    const prior = modelList.find((model) => model.provider === provider.value &&
                        model.apiUrl === apiUrl.value.trim() &&
                        model.externalModelName === choice.id);
                    const config = modelConfig(choice.id, choice.displayName || choice.id, prior?.name || uniqueName(`models/${provider.value}/${choice.id}`));
                    // Prefer explicit form overrides; otherwise retain the catalog's advertised limits/capabilities.
                    for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking']) {
                        if (config[key] === undefined && choice[key] !== undefined)
                            config[key] = choice[key];
                    }
                    if (typeof config.contextWindow === 'number' &&
                        typeof config.maxOutputTokens === 'number' &&
                        config.maxOutputTokens >= config.contextWindow &&
                        !maxOutput.value.trim()) {
                        config.maxOutputTokens = config.contextWindow > 1 ? config.contextWindow - 1 : undefined;
                    }
                    delete config.originalName;
                    if (prior)
                        config.originalName = prior.name;
                    else if (existing?.name)
                        config.copyFrom = existing.name;
                    requireSuccess(await storageAPI.saveCustomModel(config));
                    saved++;
                }
                await modelsChanged();
                setStatus(status, `Saved ${saved} models.`);
            }, status));
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
        }
        catch (error) {
            setStatus(status, error instanceof Error ? error.message : 'Could not open model settings.', true);
        }
    }
    async function openImportExport(kind) {
        const { body, status } = openModal(kind === 'export' ? 'Export models' : 'Import models');
        body.append(element('p', 'agy-muted', kind === 'export'
            ? 'Credentials are removed from this export. Add API keys on the destination device.'
            : 'Paste a model configuration as JSON or an exported base64 string. Existing configurations are merged by name.'));
        const input = jsonField(body, 'Configuration', 'agy-config-json', undefined);
        input.rows = 14;
        if (kind === 'export') {
            input.readOnly = true;
            try {
                input.value = JSON.stringify(await electron_1.ipcRenderer.invoke('storage:export-custom-models'), null, 2);
            }
            catch (error) {
                setStatus(status, String(error), true);
            }
            const actions = element('div', 'agy-actions');
            actions.append(button('Select all', () => {
                input.focus();
                input.select();
            }, status), button('Copy JSON', async () => {
                await navigator.clipboard.writeText(input.value);
                setStatus(status, 'Configuration copied.');
            }, status));
            body.append(actions);
        }
        else {
            const file = field(body, 'Or choose a JSON file', 'agy-import-file', '', 'file');
            file.accept = '.json,application/json';
            file.addEventListener('change', async () => {
                try {
                    const selected = file.files?.[0];
                    if (!selected)
                        return;
                    if (selected.size > 2 * 1024 * 1024)
                        throw new Error('Configuration files must be smaller than 2 MB.');
                    input.value = await selected.text();
                }
                catch (error) {
                    setStatus(status, String(error), true);
                }
            });
            body.append(button('Import configuration', async () => {
                if (!input.value.trim())
                    throw new Error('Paste a configuration or choose a file first.');
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:import-custom-models', input.value.trim()));
                await modelsChanged();
                setStatus(status, `Imported ${result.count ?? 0} models. Add any missing API keys before use.`);
            }, status, true));
        }
    }
    async function discoverLocal() {
        const { body, status } = openModal('Local model servers');
        setStatus(status, 'Checking Ollama, LM Studio and llama.cpp on this computer…');
        try {
            const result = (await electron_1.ipcRenderer.invoke('storage:discover-local'));
            requireSuccess(result);
            if (!body.isConnected)
                return;
            setStatus(status, result.servers?.length
                ? 'Choose a server to configure its models.'
                : 'No local model servers were found. Start a server or add its URL manually.');
            for (const server of result.servers || []) {
                const row = element('div', 'agy-row');
                row.append(element('span', '', `${server.provider} · ${server.models.length} models`), element('div', 'agy-muted', server.apiUrl), button('Configure', () => openModelModal({ name: '', provider: server.provider, apiUrl: server.apiUrl, apiKey: 'none', externalModelName: '' }, 'discover'), status));
                body.append(row);
            }
        }
        catch (error) {
            setStatus(status, String(error), true);
        }
    }
    function openGenerationTest(model) {
        const { body, status } = openModal('Test model generation');
        body.append(element('p', '', `Model: ${model.displayName || model.externalModelName || model.name}`));
        body.append(element('p', 'agy-muted', 'Sends one “Reply with OK.” request with a 32-token output limit using this model’s saved settings. Your provider may charge for the request. No conversation content is sent.'));
        body.append(button('Run generation test', async () => {
            setStatus(status, 'Sending a short generation test…');
            const result = requireSuccess(await storageAPI.testModelGeneration(model));
            setStatus(status, result.message || 'Generation succeeded.');
        }, status, true));
    }
    async function openDiagnostics() {
        const { body, status } = openModal('Proxy diagnostics');
        body.append(element('p', 'agy-muted', 'Measured requests from this proxy process only; restarting clears the history. Up to 200 completed requests are retained. Prompts, responses, URLs and credentials are not recorded. Gateway requests have separate history in its dashboard.'));
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
        let snapshot;
        const token = (value) => (typeof value === 'number' ? value.toLocaleString() : 'unknown');
        const render = () => {
            if (!snapshot)
                return;
            const s = snapshot.summary;
            summary.replaceChildren(element('p', '', `${s.requests} completed · ${snapshot.active} active · ${s.succeeded} succeeded · ${s.failed} failed · ${s.cancelled} cancelled`));
            summary.append(element('p', 'agy-muted', s.measuredRequests
                ? `Provider-reported tokens: ${token(s.measuredInputRequests ? s.inputTokens : undefined)} input · ${token(s.measuredOutputRequests ? s.outputTokens : undefined)} output · ${token(s.measuredCachedRequests ? s.cachedTokens : undefined)} cached. Usage received for ${s.measuredRequests} of ${s.requests} requests; totals exclude unknown usage.`
                : 'Token usage: unknown. No provider-reported usage received yet.'));
            recent.replaceChildren();
            if (snapshot.recentModels.length)
                recent.append(element('p', 'agy-muted', `Recently used: ${snapshot.recentModels.join(' · ')}`));
            list.replaceChildren();
            const query = search.value.trim().toLowerCase();
            const rows = snapshot.requests.filter((r) => `${r.model} ${r.provider}`.toLowerCase().includes(query));
            if (!rows.length)
                list.append(element('p', 'agy-muted', 'No matching requests recorded.'));
            for (const r of rows) {
                const row = element('div', 'agy-row');
                row.append(element('strong', '', `${r.model} · ${r.provider}`));
                row.append(element('div', 'agy-muted', `${new Date(r.timestamp).toLocaleTimeString()} · ${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.latencyMs} ms · ${r.kind === 'generation-test' ? 'generation test' : r.stream ? 'streaming' : 'request'}`));
                row.append(element('div', 'agy-muted', `Tokens: ${token(r.inputTokens)} input · ${token(r.outputTokens)} output · ${token(r.cachedTokens)} cached`));
                list.append(row);
            }
        };
        const refresh = async () => {
            snapshot = await electron_1.ipcRenderer.invoke('storage:get-diagnostics');
            requireSuccess(snapshot);
            if (body.isConnected)
                render();
        };
        search.addEventListener('input', render);
        const actions = element('div', 'agy-actions');
        actions.append(button('Refresh diagnostics', refresh, status), button('Export diagnostics', () => {
            output.value = JSON.stringify(snapshot, null, 2);
            output.hidden = false;
            output.focus();
            output.select();
        }, status), button('Clear diagnostic history', async () => {
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:clear-diagnostics'));
            output.value = '';
            output.hidden = true;
            await refresh();
        }, status));
        body.append(summary, recent, actions, output, list);
        await refresh();
    }
    async function openGateway() {
        const { body, status } = openModal('Remote gateway');
        try {
            const saved = (await electron_1.ipcRenderer.invoke('storage:get-gateway'));
            if (!body.isConnected)
                return;
            body.append(element('p', 'agy-muted', 'Connect to your proxy gateway to import its model aliases and open its management dashboard.'));
            const url = field(body, 'Gateway URL', 'agy-gateway-url', saved?.url || '', 'url');
            const token = field(body, 'Gateway token', 'agy-gateway-token', saved?.token || '', 'password');
            const dashboard = field(body, 'Dashboard URL (optional)', 'agy-dashboard-url', saved?.dashboardUrl || '', 'url');
            const config = () => ({
                url: validUrl(url.value),
                token: token.value.trim(),
                dashboardUrl: dashboard.value.trim() ? validUrl(dashboard.value) : '',
            });
            const save = async () => {
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:save-gateway', config()));
            };
            const actions = element('div', 'agy-actions');
            actions.append(button('Save connection', async () => {
                await save();
                setStatus(status, 'Gateway connection saved.');
            }, status, true), button('Test gateway', async () => {
                setStatus(status, 'Connecting…');
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:test-gateway', config()));
                setStatus(status, result.message || 'Gateway reachable and authentication accepted.');
            }, status), button('Import model aliases', async () => {
                await save();
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:import-gateway-models'));
                await modelsChanged();
                setStatus(status, `Imported ${result.count ?? 0} gateway models.`);
            }, status), button('Open dashboard', async () => {
                await save();
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:open-gateway-dashboard'));
            }, status));
            body.append(actions);
        }
        catch (error) {
            setStatus(status, String(error), true);
        }
    }
    function findSettingsMount() {
        // Desktop settings are a modal over /c/...; older layouts use a settings route.
        // A chat span saying "MCP" is not evidence that the settings page is open.
        const settingsRoot = Array.from(document.querySelectorAll('[role="dialog"][aria-label="Settings"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"]')).find(isSettingsContent);
        const settingsRoute = /^\/settings(?:\/|$)/i.test(window.location.pathname) || /^#\/?settings(?:\/|\?|$)/i.test(window.location.hash);
        const root = settingsRoot || (settingsRoute ? document.body : null);
        if (!root)
            return null;
        const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,[role="heading"],div,span'));
        const heading = headings.find((node) => node.children.length === 0 &&
            /^(Models\s*(?:&|and)\s*Usage|Model Settings|MCP Servers|MCP)$/i.test(node.textContent?.trim() || '') &&
            isSettingsContent(node));
        if (heading) {
            const section = heading.closest('section');
            if (section && root.contains(section))
                return section;
            const panel = heading.closest('[role="tabpanel"]');
            if (panel && root.contains(panel))
                return panel;
            let content = heading;
            while (content.parentElement && content.parentElement !== root) {
                if (content.parentElement.classList.contains('overflow-y-auto'))
                    return content;
                content = content.parentElement;
            }
            const fallback = heading.parentElement?.parentElement || heading.parentElement;
            return fallback && root.contains(fallback) ? fallback : root;
        }
        const refresh = findRefreshButton(root);
        const legacy = refresh?.parentElement?.parentElement?.parentElement;
        if (legacy &&
            root.contains(legacy) &&
            isSettingsContent(legacy) &&
            /MCP|Model Context Protocol/i.test(legacy.textContent || ''))
            return legacy;
        return null;
    }
    function injectCustomModelsSection() {
        const mount = findSettingsMount();
        const existing = document.getElementById('agy-custom-models-section');
        if (existing && mount && existing.parentElement === mount)
            return;
        existing?.remove();
        if (!mount)
            return;
        installStyles();
        const section = element('section');
        section.id = 'agy-custom-models-section';
        section.setAttribute('aria-label', 'Custom Models');
        const header = element('div', 'agy-toolbar');
        const addModel = button('Add model', () => openModelModal(), undefined, true);
        addModel.id = 'agy-add-model';
        header.append(element('h2', '', 'Custom Models'), addModel);
        const actions = element('div', 'agy-actions');
        actions.append(button('Discover local', discoverLocal), button('Import', () => openImportExport('import')), button('Export', () => openImportExport('export')), button('Remote gateway', openGateway), button('Diagnostics', openDiagnostics));
        const search = field(section, 'Search models', 'agy-model-search', searchTerm, 'search');
        search.placeholder = 'Search by name, model ID or provider';
        search.addEventListener('input', () => {
            searchTerm = search.value.trim().toLowerCase();
            void renderCustomModelsList();
        });
        const content = element('div');
        content.id = 'agy-custom-models-content';
        const fleet = element('div', 'agy-fleet');
        fleet.id = 'agy-google-account-pool-section';
        fleet.setAttribute('aria-label', 'Google account fleet and quotas');
        fleet.hidden = true;
        const status = statusNode();
        status.id = 'agy-main-status';
        section.prepend(header, element('p', 'agy-muted', 'Provider connections, local models and remote gateways.'), actions);
        section.append(status, fleet, content);
        mount.append(section);
        void renderCustomModelsList(true);
    }
    let pickerSearch;
    function pickerVisible(menu) {
        if (!menu.isConnected)
            return false;
        for (let node = menu; node; node = node.parentElement) {
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-state') === 'closed')
                return false;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    }
    function checkModelPickerSearch() {
        if (pickerSearch) {
            if (pickerVisible(pickerSearch.menu)) {
                pickerSearch.update();
                return;
            }
            pickerSearch.cleanup();
            pickerSearch = undefined;
        }
        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'));
        const menu = menus.find((candidate) => {
            if (!pickerVisible(candidate) || candidate.closest('#agy-modal-overlay, #agy-custom-models-section') ||
                candidate.parentElement?.closest('[role="menu"], [role="listbox"]') ||
                candidate.matches('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]'))
                return false;
            const trigger = document.getElementById(candidate.getAttribute('aria-labelledby') || '');
            if (trigger?.closest('[role="menuitem"], [role="menuitemradio"]'))
                return false;
            const leaves = Array.from(candidate.querySelectorAll('*')).filter((node) => !node.children.length);
            const labels = leaves.map((node) => node.textContent?.trim() || '').filter(Boolean);
            return labels.slice(0, 2).includes('Model') && labels.some((label) => /^View\s+Usage$/i.test(label));
        });
        if (!menu)
            return;
        installStyles();
        const box = element('div', 'agy-model-search-box');
        const input = element('input', 'agy-model-search-input');
        input.type = 'search';
        input.placeholder = 'Search models…';
        input.setAttribute('aria-label', 'Search models');
        const empty = element('div', 'agy-model-no-results', 'No matching models');
        empty.hidden = true;
        box.append(input);
        const header = Array.from(menu.querySelectorAll('*')).find((node) => !node.children.length && node.textContent?.trim() === 'Model');
        (header || menu).insertAdjacentElement(header ? 'afterend' : 'afterbegin', box);
        box.after(empty);
        const displays = new Map();
        const items = () => Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button'))
            .filter((node) => !node.parentElement?.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]') &&
            !node.closest('.agy-model-search-box') && !/^View\s+Usage/i.test(node.textContent?.trim() || ''));
        const restore = (node) => {
            const old = displays.get(node);
            if (!old)
                return;
            if (old.value)
                node.style.setProperty('display', old.value, old.priority);
            else
                node.style.removeProperty('display');
            displays.delete(node);
        };
        const update = () => {
            const query = input.value.trim().toLowerCase();
            let matches = 0;
            for (const node of items()) {
                const matched = !query || (node.textContent || '').toLowerCase().includes(query);
                if (matched) {
                    if (displays.has(node))
                        restore(node);
                    if (pickerVisible(node))
                        matches++;
                }
                else if (!displays.has(node)) {
                    displays.set(node, { value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') });
                    node.style.setProperty('display', 'none', 'important');
                }
            }
            const hidden = !query || matches > 0;
            if (empty.hidden !== hidden)
                empty.hidden = hidden;
        };
        for (const event of ['pointerdown', 'mousedown', 'click'])
            box.addEventListener(event, (e) => e.stopPropagation());
        input.addEventListener('input', update);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !input.value)
                return;
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                input.value = '';
                update();
            }
            else if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                const first = items().find((node) => pickerVisible(node) && node.getAttribute('aria-disabled') !== 'true' && !node.disabled);
                if (event.key === 'Enter')
                    first?.click();
                else
                    first?.focus();
            }
        });
        pickerSearch = { menu, update, cleanup: () => { for (const node of displays.keys())
                restore(node); box.remove(); empty.remove(); } };
        setTimeout(() => { if (box.isConnected && pickerVisible(menu))
            input.focus(); }, 0);
    }
    // --- Context Window Indicator Ring ---------------------------------------
    let activeOpenedConvId = null;
    let activeConvTokens = 0;
    let lastContextFetchTime = 0;
    let isContextFetching = false;
    let contextRingTimer;
    function normalizeModelName(str) {
        if (!str || typeof str !== 'string')
            return '';
        return str
            .replace(/[\u25be\u25b2\u25bc\u25c2\u25b8\u25c0\u25b6\^v]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    function cleanModelSlug(s) {
        if (!s || typeof s !== 'string')
            return '';
        return s
            .toLowerCase()
            .replace(/[\u25be\u25b2\u25bc\u25c2\u25b8\u25c0\u25b6\^v]/g, ' ')
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/^models\//, '')
            .replace(/^[^/]+\//, '')
            .replace(/[-_/]free\b/g, '')
            .replace(/\bfree[-_/]/g, '')
            .replace(/[^a-z0-9.]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }
    function resolveModelLimit(name, models) {
        if (!name)
            return undefined;
        const clean = normalizeModelName(name);
        if (!clean)
            return undefined;
        const list = models && models.length > 0 ? models : customModelsCache.models;
        // 1. Search configured custom models from database FIRST
        if (list && Array.isArray(list)) {
            const slug = cleanModelSlug(clean);
            for (const cm of list) {
                const cmName = normalizeModelName(cm.name || '');
                const cmDisplay = normalizeModelName(cm.displayName || '');
                const cmExt = normalizeModelName(cm.externalModelName || '');
                const cmSlug = cleanModelSlug(cm.displayName || cm.name || '');
                const matched = (cmDisplay && (clean === cmDisplay || clean.includes(cmDisplay) || cmDisplay.includes(clean))) ||
                    (cmName && (clean === cmName || clean.includes(cmName) || cmName.includes(clean))) ||
                    (cmExt && (clean === cmExt || clean.includes(cmExt) || cmExt.includes(clean))) ||
                    (slug && cmSlug && (slug === cmSlug || slug.includes(cmSlug) || cmSlug.includes(slug)));
                if (matched) {
                    if (typeof cm.contextWindow === 'number' && cm.contextWindow > 0)
                        return cm.contextWindow;
                    if (typeof cm.nativeContextWindow === 'number' && cm.nativeContextWindow > 0) {
                        return cm.nativeContextWindow;
                    }
                }
            }
        }
        // 2. Official Gemini family
        if (clean.includes('gemini')) {
            if (clean.includes('pro') || clean.includes('1.5-pro') || clean.includes('2.5-pro'))
                return 2000000;
            if (clean.includes('flash') ||
                clean.includes('1.5-flash') ||
                clean.includes('2.0-flash') ||
                clean.includes('2.5-flash') ||
                clean.includes('3.8-flash'))
                return 1000000;
            if (clean.includes('1.0-pro') || clean.includes('1.0 pro'))
                return 32000;
            return 1000000;
        }
        // 3. Official Anthropic Claude family
        if (clean.includes('claude') || clean.includes('sonnet') || clean.includes('opus') || clean.includes('haiku')) {
            return 200000;
        }
        // 4. OpenAI reasoning models
        if (/\bo[13](?:-mini|-preview)?\b/.test(clean))
            return 200000;
        // 5. OpenAI GPT-4 family
        if (clean.includes('gpt-4') || clean.includes('gpt4') || clean.includes('chatgpt'))
            return 128000;
        // 6. DeepSeek family
        if (clean.includes('deepseek'))
            return 64000;
        // 7. Open-weights & other providers
        if (clean.includes('mistral') || clean.includes('codestral') || clean.includes('llama') || clean.includes('qwen')) {
            return 128000;
        }
        return undefined;
    }
    function formatContextUnit(tokens) {
        if (typeof tokens !== 'number' || isNaN(tokens) || tokens <= 0)
            return '0';
        if (tokens >= 1000000) {
            const m = tokens / 1000000;
            return (Number.isInteger(m) ? m.toString() : m.toFixed(1).replace(/\.0$/, '')) + 'M';
        }
        const k = tokens / 1000;
        return (Number.isInteger(k) ? k.toString() : Math.round(k).toString()) + 'k';
    }
    function getConversationIdFromFiber(el) {
        if (!el)
            return null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        try {
            const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (!fiberKey)
                return null;
            let curr = el[fiberKey];
            let depth = 0;
            while (curr && depth < 200) {
                depth++;
                if (curr.memoizedProps) {
                    const props = curr.memoizedProps;
                    const candidate = props.conversationId ||
                        props.cascadeId ||
                        props.conversation?.id ||
                        props.cascade?.id ||
                        props.chatSession?.id ||
                        props.session?.id ||
                        props.sessionId ||
                        props.trajectoryId ||
                        props.threadId ||
                        props.activeConversationId ||
                        props.currentConversationId;
                    if (typeof candidate === 'string' && uuidRegex.test(candidate))
                        return candidate;
                    for (const val of Object.values(props)) {
                        if (typeof val === 'string' && uuidRegex.test(val))
                            return val;
                        if (val && typeof val === 'object' && !Array.isArray(val)) {
                            const obj = val;
                            if (typeof obj.id === 'string' && uuidRegex.test(obj.id))
                                return obj.id;
                            if (typeof obj.conversationId === 'string' && uuidRegex.test(obj.conversationId))
                                return obj.conversationId;
                            if (typeof obj.cascadeId === 'string' && uuidRegex.test(obj.cascadeId))
                                return obj.cascadeId;
                        }
                    }
                }
                if (curr.memoizedState) {
                    let state = curr.memoizedState;
                    let sDepth = 0;
                    while (state && sDepth < 15) {
                        sDepth++;
                        const val = state.memoizedState ?? state.baseState;
                        if (typeof val === 'string' && uuidRegex.test(val))
                            return val;
                        if (val && typeof val === 'object') {
                            if (typeof val.conversationId === 'string' && uuidRegex.test(val.conversationId))
                                return val.conversationId;
                            if (typeof val.cascadeId === 'string' && uuidRegex.test(val.cascadeId))
                                return val.cascadeId;
                            if (typeof val.id === 'string' && uuidRegex.test(val.id))
                                return val.id;
                        }
                        state = state.next;
                    }
                }
                curr = curr.return;
            }
        }
        catch { }
        return null;
    }
    function extractUuidFromDom(root) {
        if (!root)
            return null;
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const attrs = [
            'data-conversation-id',
            'data-cascade-id',
            'data-id',
            'data-resource-name',
            'data-resource',
            'data-uri',
            'title',
            'aria-label',
        ];
        for (const attr of attrs) {
            const val = root.getAttribute(attr);
            if (val) {
                const m = val.match(uuidRegex);
                if (m && m[0])
                    return m[0];
            }
        }
        const dataset = root.dataset;
        if (dataset) {
            if (dataset.conversationId && uuidRegex.test(dataset.conversationId))
                return dataset.conversationId;
            if (dataset.cascadeId && uuidRegex.test(dataset.cascadeId))
                return dataset.cascadeId;
        }
        return null;
    }
    function findActiveComposer() {
        if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') {
            const box = document.activeElement.closest('[data-testid="agent-input-box"], .no-focus-agent-input, form:has(textarea), div:has(> textarea)');
            if (box && pickerVisible(box))
                return box;
        }
        const focusedBox = document.querySelector('[data-testid="agent-input-box"]:focus-within, .no-focus-agent-input:focus-within');
        if (focusedBox && pickerVisible(focusedBox))
            return focusedBox;
        const activeEditor = document.querySelector('.editor-group-container.active, .editor-instance:not([style*="display: none"]):not([hidden])');
        if (activeEditor) {
            const box = activeEditor.querySelector('[data-testid="agent-input-box"], .no-focus-agent-input, form:has(textarea), div:has(> textarea)');
            if (box && pickerVisible(box))
                return box;
        }
        const candidates = Array.from(document.querySelectorAll('[data-testid="agent-input-box"], .no-focus-agent-input, form:has(textarea), div:has(> textarea)'));
        for (const box of candidates) {
            if (pickerVisible(box))
                return box;
        }
        return null;
    }
    function findModelTrigger(composer) {
        const root = composer || document;
        // 1. Explicit data-testid
        const explicit = root.querySelector('[data-testid="model-selector-trigger"]');
        if (explicit && pickerVisible(explicit))
            return explicit;
        // 2. Select model button
        const selectBtn = root.querySelector('button[aria-label*="Select model" i], [role="button"][aria-label*="Select model" i], button[aria-label*="Choose model" i], button[aria-label*="Switch model" i]');
        if (selectBtn && pickerVisible(selectBtn))
            return selectBtn;
        // 3. Search in composer toolbar for button containing model name or chevron
        const parentBox = composer || document.querySelector('[data-testid="agent-input-box"], .no-focus-agent-input, form:has(textarea), div:has(> textarea)');
        if (parentBox) {
            const buttons = Array.from(parentBox.querySelectorAll('button, [role="button"]'));
            for (const btn of buttons) {
                if (!pickerVisible(btn))
                    continue;
                const text = btn.textContent?.trim().toLowerCase() || '';
                if (text === '+' || (text === '' && btn.querySelector('svg, .codicon-add, .codicon-plus')))
                    continue;
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes('attach') || aria.includes('add context') || aria.includes('mention') || aria.includes('send') || aria.includes('submit'))
                    continue;
                const matchesCustom = customModelsCache.models.some((m) => {
                    const d = (m.displayName || '').toLowerCase();
                    const n = (m.name || '').toLowerCase();
                    return (d.length >= 3 && text.includes(d)) || (n.length >= 3 && text.includes(n));
                });
                if (matchesCustom ||
                    text.includes('gemini') ||
                    text.includes('flash') ||
                    text.includes('pro') ||
                    text.includes('claude') ||
                    text.includes('sonnet') ||
                    text.includes('opus') ||
                    text.includes('haiku') ||
                    text.includes('gpt') ||
                    text.includes('o1') ||
                    text.includes('o3') ||
                    text.includes('deepseek') ||
                    text.includes('llama') ||
                    text.includes('qwen') ||
                    text.includes('mistral') ||
                    (btn.querySelector('.codicon-chevron-down, svg') && text.length > 2 && text.length < 50)) {
                    return btn;
                }
            }
        }
        return null;
    }
    function getOpenedConversationInfo(composer, trigger) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const info = {};
        // 1. URL / window.location route
        try {
            const loc = `${window.location.pathname || ''} ${window.location.hash || ''} ${window.location.href || ''}`;
            const urlMatch = loc.match(/(?:\/c\/|[?&#](?:c|conversation|session)=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (urlMatch && urlMatch[1] && uuidRegex.test(urlMatch[1])) {
                info.conversationId = urlMatch[1];
                return info;
            }
        }
        catch { }
        // 2. Active / highlighted conversation row in the sidebar
        const activeRow = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"], ' +
            '[data-testid="conversation-row-sidebar"][aria-selected="true"], ' +
            '[data-testid="conversation-row-sidebar"][data-state="active"], ' +
            '[data-testid="conversation-row-sidebar"][data-active="true"], ' +
            '[data-testid="conversation-row-sidebar"].bg-accent, ' +
            '[data-testid="conversation-row-sidebar"].bg-sidebar-accent, ' +
            '[data-testid="conversation-row-sidebar"].active, ' +
            '[data-testid="conversation-row-sidebar"]:has(.bg-accent), ' +
            '[data-testid="conversation-row-sidebar"]:has(.bg-sidebar-accent)');
        if (activeRow) {
            const rowId = activeRow.getAttribute('data-cascade-id') ||
                activeRow.getAttribute('data-id') ||
                activeRow.getAttribute('data-conversation-id') ||
                activeRow.dataset?.cascadeId ||
                activeRow.dataset?.id ||
                activeRow.dataset?.conversationId;
            if (rowId && uuidRegex.test(rowId)) {
                info.conversationId = rowId;
                return info;
            }
            const link = activeRow.querySelector('a[href*="/c/"]');
            if (link) {
                const m = link.getAttribute('href')?.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                if (m && m[1]) {
                    info.conversationId = m[1];
                    return info;
                }
            }
            const rowFiberId = getConversationIdFromFiber(activeRow);
            if (rowFiberId && uuidRegex.test(rowFiberId)) {
                info.conversationId = rowFiberId;
                return info;
            }
            const titleEl = activeRow.querySelector('.title, span, div');
            const rowTitle = (titleEl?.textContent || activeRow.textContent || '').trim();
            if (rowTitle && rowTitle.length > 1) {
                info.title = rowTitle;
            }
        }
        const activeTab = document.querySelector('.tab.active, [role="tab"][aria-selected="true"], .tabs-container .tab.active');
        if (activeTab) {
            const tabId = getConversationIdFromFiber(activeTab) || extractUuidFromDom(activeTab);
            if (tabId && uuidRegex.test(tabId)) {
                info.conversationId = tabId;
                return info;
            }
            const label = activeTab.querySelector('.tab-label, [title]') || activeTab;
            const tabTitle = (label.getAttribute('title') || label.textContent || '').trim();
            if (tabTitle && tabTitle.length > 1) {
                info.title = tabTitle;
            }
        }
        const messageNodes = Array.from(document.querySelectorAll('[data-testid*="chat-turn" i], [data-testid*="message" i], [data-testid*="cascade-turn" i], ' +
            '[class*="chat-turn" i], [class*="message-item" i], [class*="chat-message" i], div.prose'));
        for (const msg of messageNodes) {
            const id = extractUuidFromDom(msg) || getConversationIdFromFiber(msg);
            if (id && uuidRegex.test(id)) {
                info.conversationId = id;
                return info;
            }
        }
        const brainElements = Array.from(document.querySelectorAll('a[href*="brain"], [data-uri*="brain"], img[src*="brain"], [data-path*="brain"]'));
        for (const bEl of brainElements) {
            const href = bEl.getAttribute('href') || bEl.getAttribute('data-uri') || bEl.getAttribute('src') || bEl.getAttribute('data-path') || '';
            const m = href.match(/brain[\\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (m && m[1] && uuidRegex.test(m[1])) {
                info.conversationId = m[1];
                return info;
            }
        }
        const textarea = composer?.querySelector('textarea') || (document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement : null);
        const chatView = document.querySelector('[data-testid="conversation-view"], [data-testid="chat-messages"], [data-testid="cascade-view"], [data-testid="main-conversation-panel"]');
        const targets = [composer, textarea, trigger, chatView].filter(Boolean);
        for (const target of targets) {
            const id = getConversationIdFromFiber(target) || extractUuidFromDom(target);
            if (id && uuidRegex.test(id)) {
                info.conversationId = id;
                return info;
            }
        }
        try {
            for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith('antigravity-multi-conversation-layout-v3-')) {
                    const possibleId = key.replace('antigravity-multi-conversation-layout-v3-', '');
                    if (uuidRegex.test(possibleId)) {
                        const raw = window.localStorage.getItem(key);
                        if (raw && raw.includes(possibleId)) {
                            info.conversationId = possibleId;
                            break;
                        }
                    }
                }
            }
        }
        catch { }
        return info;
    }
    function hasActiveChatMessages() {
        const messageEl = document.querySelector('[data-testid*="chat-turn" i], [data-testid*="message" i], [data-testid*="cascade-turn" i], ' +
            '[class*="chat-turn" i], [class*="message-item" i], [class*="chat-message" i], ' +
            'div.prose, [data-testid*="turn-" i]');
        if (messageEl)
            return true;
        const chatView = document.querySelector('[data-testid="conversation-view"], [data-testid="cascade-view"], [data-testid="chat-messages"]');
        if (chatView) {
            const turns = chatView.querySelectorAll('[data-testid], [class*="turn"], [class*="message"], [role="article"]');
            for (const t of Array.from(turns)) {
                if (t.classList.contains('agy-context-ring') || t.id.startsWith('agy-'))
                    continue;
                if (t.textContent && t.textContent.trim().length > 30)
                    return true;
            }
        }
        const codeBlocks = document.querySelector('.monaco-editor, pre code, [data-testid*="code-block"]');
        if (codeBlocks && !codeBlocks.closest('#agy-custom-models-section, #agy-modal-overlay')) {
            return true;
        }
        return false;
    }
    function showFloatingTooltip(anchorEl, text) {
        if (!text || !anchorEl.isConnected)
            return;
        let tip = document.getElementById('agy-context-floating-tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'agy-context-floating-tooltip';
            document.body.appendChild(tip);
        }
        tip.textContent = text;
        const rect = anchorEl.getBoundingClientRect();
        const left = Math.round(rect.left + rect.width / 2);
        const top = Math.round(rect.top - 8);
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.style.display = 'block';
        tip.style.opacity = '1';
    }
    function hideFloatingTooltip() {
        const tip = document.getElementById('agy-context-floating-tooltip');
        if (tip) {
            tip.style.opacity = '0';
            tip.style.display = 'none';
        }
    }
    function extractModelNameFromTrigger(trigger) {
        const clone = trigger.cloneNode(true);
        clone.querySelectorAll('.agy-context-ring, [id^="agy-context-window-ring"], svg, .codicon').forEach((el) => el.remove());
        return clone.textContent?.trim() || '';
    }
    function applyContextRingUI(trigger, maxTokens, currentTokens) {
        installStyles();
        let ring = document.getElementById('agy-context-window-ring');
        if (!ring) {
            ring = element('div', 'agy-context-ring');
            ring.id = 'agy-context-window-ring';
            ring.setAttribute('role', 'status');
            ring.setAttribute('tabindex', '0');
            ring.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                lastContextFetchTime = 0;
                updateContextWindowRing(true);
            });
            ring.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            ring.addEventListener('mouseenter', () => {
                updateContextWindowRing(true);
                const tipText = ring?.getAttribute('data-tooltip') || ring?.getAttribute('aria-label') || '';
                if (ring)
                    showFloatingTooltip(ring, tipText);
            });
            ring.addEventListener('mousemove', () => {
                const tipText = ring?.getAttribute('data-tooltip') || ring?.getAttribute('aria-label') || '';
                if (ring)
                    showFloatingTooltip(ring, tipText);
            });
            ring.addEventListener('mouseleave', () => {
                hideFloatingTooltip();
            });
        }
        const circumference = 44;
        let offset = circumference;
        let strokeColor = '#94a3b8';
        let tooltip = '';
        if (typeof maxTokens === 'number' && maxTokens > 0) {
            const ratio = currentTokens / maxTokens;
            const pct = Math.round(ratio * 100);
            const clamped = Math.max(0, Math.min(1, ratio));
            offset = Math.max(0, circumference - (circumference * clamped));
            if (pct >= 85)
                strokeColor = '#ef4444';
            else if (pct >= 70)
                strokeColor = '#f59e0b';
            else
                strokeColor = '#10b981';
            const pctStr = (Math.round(ratio * 1000) / 10).toFixed(1).replace(/\.0$/, '');
            const maxLabel = formatContextUnit(maxTokens);
            tooltip = `Context: ${currentTokens.toLocaleString('en-US')} / ${maxLabel} (${pctStr}%)`;
        }
        else {
            offset = circumference;
            strokeColor = '#94a3b8';
            tooltip = `Context: ${currentTokens.toLocaleString('en-US')} / Unknown`;
        }
        ring.removeAttribute('title');
        ring.setAttribute('aria-label', tooltip);
        ring.setAttribute('data-tooltip', tooltip);
        const activeTip = document.getElementById('agy-context-floating-tooltip');
        if (activeTip && activeTip.style.display === 'block') {
            activeTip.textContent = tooltip;
        }
        const ringSvg = `<svg width="18" height="18" viewBox="0 0 20 20">` +
            `<circle cx="10" cy="10" r="7" fill="none" stroke="rgba(148, 163, 184, 0.25)" stroke-width="2"></circle>` +
            `<circle cx="10" cy="10" r="7" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-dasharray="44" stroke-dashoffset="${offset.toFixed(2)}" style="transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;"></circle>` +
            `</svg>`;
        if (ring.innerHTML !== ringSvg) {
            ring.innerHTML = ringSvg;
        }
        const modelBtn = trigger.closest('button, [role="button"]') || trigger;
        const parentContainer = modelBtn.parentElement;
        if (parentContainer) {
            parentContainer.style.setProperty('display', 'inline-flex', 'important');
            parentContainer.style.setProperty('align-items', 'center', 'important');
            parentContainer.style.setProperty('flex-wrap', 'nowrap', 'important');
        }
        if (modelBtn.nextSibling !== ring) {
            modelBtn.insertAdjacentElement('afterend', ring);
        }
    }
    function renderSubagentRings() {
        const agentTags = [];
        const seen = new Set();
        document.querySelectorAll('div[title="Subagent"], div[title="Agent Script"], [data-testid="subagent-name-tag"]').forEach((tag) => {
            const box = tag.closest('[data-testid="agent-input-box"], .no-focus-agent-input') || tag.parentElement;
            if (box && !seen.has(box)) {
                seen.add(box);
                agentTags.push(tag);
            }
        });
        agentTags.forEach((tag, idx) => {
            const subRingId = `agy-context-window-ring-sub-${idx}`;
            let subRing = document.getElementById(subRingId);
            if (!subRing) {
                subRing = element('div', 'agy-context-ring');
                subRing.id = subRingId;
                subRing.setAttribute('role', 'status');
                subRing.setAttribute('tabindex', '0');
                subRing.addEventListener('mouseenter', () => {
                    const tipText = subRing?.getAttribute('data-tooltip') || subRing?.getAttribute('aria-label') || '';
                    if (subRing)
                        showFloatingTooltip(subRing, tipText);
                });
                subRing.addEventListener('mousemove', () => {
                    const tipText = subRing?.getAttribute('data-tooltip') || subRing?.getAttribute('aria-label') || '';
                    if (subRing)
                        showFloatingTooltip(subRing, tipText);
                });
                subRing.addEventListener('mouseleave', () => {
                    hideFloatingTooltip();
                });
            }
            const subConvId = getConversationIdFromFiber(tag) || extractUuidFromDom(tag);
            if (subConvId) {
                storageAPI.getChatContextUsage(subConvId).then((usage) => {
                    if (!subRing || !subRing.isConnected)
                        return;
                    const cur = usage.currentTokens || 0;
                    const subTooltip = `Subagent Context: ${cur.toLocaleString('en-US')} / Unknown`;
                    subRing.removeAttribute('title');
                    subRing.setAttribute('aria-label', subTooltip);
                    subRing.setAttribute('data-tooltip', subTooltip);
                    subRing.innerHTML =
                        `<svg width="18" height="18" viewBox="0 0 20 20">` +
                            `<circle cx="10" cy="10" r="7" fill="none" stroke="rgba(148, 163, 184, 0.25)" stroke-width="2"></circle>` +
                            `<circle cx="10" cy="10" r="7" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-dasharray="44" stroke-dashoffset="44"></circle>` +
                            `</svg>`;
                }).catch(() => { });
            }
            if (tag.parentNode && subRing.previousElementSibling !== tag) {
                tag.insertAdjacentElement('afterend', subRing);
            }
        });
    }
    function updateContextWindowRing(forceFetch = false) {
        const composer = findActiveComposer();
        const trigger = findModelTrigger(composer);
        const existingRing = document.getElementById('agy-context-window-ring');
        if (!trigger) {
            if (existingRing)
                existingRing.remove();
            return;
        }
        const triggerBox = trigger.closest ? trigger.closest('[data-testid="agent-input-box"], .no-focus-agent-input') : null;
        const isInsideSubagentBox = triggerBox && (triggerBox.querySelector('div[title="Subagent"], div[title="Agent Script"], [data-testid="subagent-name-tag"]') ||
            triggerBox.querySelector('[placeholder*="subagent"], [data-placeholder*="subagent"]') ||
            (triggerBox.textContent && triggerBox.textContent.includes('Message subagent')));
        if (isInsideSubagentBox) {
            if (existingRing)
                existingRing.remove();
            renderSubagentRings();
            return;
        }
        const modelName = extractModelNameFromTrigger(trigger);
        let maxTokens = resolveModelLimit(modelName, customModelsCache.models);
        const hasMessages = hasActiveChatMessages();
        if (!hasMessages) {
            activeOpenedConvId = 'empty-chat';
            activeConvTokens = 0;
            applyContextRingUI(trigger, maxTokens, 0);
            renderSubagentRings();
            return;
        }
        const chatInfo = getOpenedConversationInfo(composer, trigger);
        const convId = chatInfo.conversationId;
        const chatTitle = chatInfo.title;
        const sessionKey = convId || chatTitle || 'active';
        if (sessionKey !== activeOpenedConvId) {
            activeOpenedConvId = sessionKey;
            activeConvTokens = 0;
            lastContextFetchTime = 0;
        }
        const now = Date.now();
        if ((forceFetch || now - lastContextFetchTime > 1500) && !isContextFetching) {
            lastContextFetchTime = now;
            isContextFetching = true;
            storageAPI.getChatContextUsage({
                conversationId: convId,
                title: chatTitle,
                modelName,
                fallbackToLatest: hasMessages && !convId && !chatTitle,
            }).then((usage) => {
                if (usage.conversationId) {
                    activeOpenedConvId = convId || usage.conversationId;
                }
                if (typeof usage.maxTokens === 'number' && usage.maxTokens > 0) {
                    maxTokens = usage.maxTokens;
                }
                activeConvTokens = usage.currentTokens || 0;
                applyContextRingUI(trigger, maxTokens, activeConvTokens);
            }).catch(() => { }).finally(() => {
                isContextFetching = false;
            });
        }
        applyContextRingUI(trigger, maxTokens, activeConvTokens);
        renderSubagentRings();
    }
    function setupInjectionObserver() {
        injectCustomModelsSection();
        if (!document.body)
            return;
        checkModelPickerSearch();
        updateContextWindowRing();
        fleetTimer = setInterval(() => { void refreshFleetQuotas(); }, 30000);
        let wasGenerating = false;
        let pending;
        const observer = new MutationObserver(() => {
            // Check stream finish state transition
            const stopBtn = document.querySelector('button[aria-label*="Stop" i], [data-testid="stop-button"], button:has(.codicon-stop)');
            const isGenerating = Boolean(stopBtn && pickerVisible(stopBtn));
            if (wasGenerating && !isGenerating) {
                // Stream just completed! Schedule updates to allow disk write to flush
                setTimeout(() => updateContextWindowRing(true), 300);
                setTimeout(() => updateContextWindowRing(true), 1200);
            }
            wasGenerating = isGenerating;
            if (pending)
                clearTimeout(pending);
            pending = setTimeout(() => {
                pending = undefined;
                injectCustomModelsSection();
                checkModelPickerSearch();
            }, 150);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-state'],
        });
        window.addEventListener('focus', () => updateContextWindowRing(true), true);
        window.addEventListener('blur', hideFloatingTooltip, true);
        document.addEventListener('scroll', hideFloatingTooltip, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                setTimeout(() => updateContextWindowRing(true), 600);
                setTimeout(() => updateContextWindowRing(true), 2000);
            }
        }, true);
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target)
                return;
            if (target.closest('button[aria-label*="Send" i], [data-testid*="send" i], button:has(.codicon-send)')) {
                setTimeout(() => updateContextWindowRing(true), 600);
                setTimeout(() => updateContextWindowRing(true), 2000);
            }
            if (target.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]')) {
                setTimeout(() => updateContextWindowRing(true), 150);
            }
            if (target.closest('[data-testid="conversation-row-sidebar"], a[href*="/c/"], .tab, [role="tab"], [data-testid="new-conversation-button"]')) {
                setTimeout(() => updateContextWindowRing(true), 100);
                setTimeout(() => updateContextWindowRing(true), 500);
            }
        }, true);
        window.addEventListener('pagehide', () => {
            observer.disconnect();
            if (pending)
                clearTimeout(pending);
            if (fleetTimer)
                clearInterval(fleetTimer);
            if (contextRingTimer)
                clearInterval(contextRingTimer);
        }, { once: true });
    }
    // --- Network Interceptor for Model Injection --------------------------
    function isSafeToIntercept(url) {
        // Never touch the internal Connect-RPC LanguageServerService channel —
        // those responses are protocol-framed, not plain JSON, and rewriting
        // them corrupts the renderer's RPC client / store hydration.
        if (url.includes('exa.language_server_pb.'))
            return false;
        if (url.includes('/LanguageServerService/'))
            return false;
        return true;
    }
    function isJsonResponse(contentType) {
        return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
    }
    const customModelsCache = { models: [], ts: 0 };
    function injectMissingCustomModels(parsed, customModels) {
        const key = ['models', 'availableModels', 'available_models'].find((name) => parsed[name] !== undefined) || 'models';
        const collection = parsed[key];
        // Preserve list/protocol shapes we do not own; the proxy handles array catalogs.
        if (collection !== undefined && (!collection || typeof collection !== 'object' || Array.isArray(collection)))
            return false;
        const modelsObj = (collection || {});
        const legacySlug = (model) => 'custom-' + String(model.externalModelName || model.name || '')
            .replace(/^models\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
        const usedLabels = new Set(Object.values(modelsObj).map((entry) => entry?.displayName).filter((label) => typeof label === 'string'));
        let changed = false;
        for (const model of customModels) {
            if (model.nativePickerAvailable === false)
                continue;
            const authoritative = typeof model.nativeCatalogId === 'string' && typeof model.nativeModelId === 'string';
            const slug = authoritative ? model.nativeCatalogId : legacySlug(model);
            // Compatibility with older IPC: never guess a shared external alias for effort variants.
            if (!authoritative && customModels.filter((other) => legacySlug(other) === slug).length !== 1)
                continue;
            const placeholder = authoritative ? model.nativeModelId : 'MODEL_PLACEHOLDER_M' +
                (400 + hashCodeStr(String(model.displayName || model.name || 'custom-model').toLowerCase()) % 200);
            const baseLabel = model.displayName || model.name;
            // The proxy is authoritative. Reinjection must not overwrite its capabilities or add a legacy duplicate.
            if (Object.prototype.hasOwnProperty.call(modelsObj, slug) || Object.entries(modelsObj).some(([id, entry]) => id.startsWith('custom-') && entry?.model === placeholder && entry.displayName === baseLabel))
                continue;
            let displayName = baseLabel;
            if (usedLabels.has(displayName) || customModels.filter((entry) => (entry.displayName || entry.name) === baseLabel).length > 1)
                displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')})`;
            let suffix = 2;
            while (usedLabels.has(displayName))
                displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')} #${suffix++})`;
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
        if (changed)
            parsed[key] = modelsObj;
        return changed;
    }
    async function getCustomModelsForInjection() {
        if (Date.now() - customModelsCache.ts < 30000)
            return customModelsCache.models;
        try {
            customModelsCache.models = (await storageAPI.getCustomModels()).filter((model) => model.enabled !== false);
            customModelsCache.ts = Date.now();
        }
        catch {
            /* ignore */
        }
        return customModelsCache.models;
    }
    // Intercept XHR to inject custom models into GetAvailableModels responses
    const origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, username, password) {
        this._agy_url = typeof url === 'string' ? url : url.toString();
        this._agy_method = method;
        this._agy_async = async !== false;
        return origXHROpen.call(this, method, url, async !== false, username, password);
    };
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._agy_url || '';
        if ((url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) && isSafeToIntercept(url)) {
            // Warm the cache without delaying native XHR events. If it is not ready by
            // DONE, leave the response alone; load/readystatechange ordering must survive.
            if (this._agy_async)
                void getCustomModelsForInjection();
            const origOnReady = this.onreadystatechange;
            this.onreadystatechange = (ev) => {
                if (this.readyState === 4 &&
                    this.status === 200 &&
                    (this.responseType === '' || this.responseType === 'text') &&
                    isJsonResponse(this.getResponseHeader('content-type'))) {
                    const customModels = customModelsCache.models;
                    if (customModels && customModels.length > 0) {
                        try {
                            const responseText = this.responseText;
                            if (responseText && responseText.length > 10) {
                                const parsed = JSON.parse(responseText);
                                if (injectMissingCustomModels(parsed, customModels)) {
                                    // Override only a changed response; keep native event ordering intact.
                                    Object.defineProperty(this, 'responseText', { value: JSON.stringify(parsed), writable: true });
                                    Object.defineProperty(this, 'response', { value: JSON.stringify(parsed), writable: true });
                                }
                            }
                        }
                        catch {
                            /* ignore parse errors */
                        }
                    }
                }
                if (origOnReady)
                    origOnReady.call(this, ev);
            };
        }
        return origXHRSend.call(this, body);
    };
    // Intercept fetch responses for model endpoints
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const response = await origFetch.call(window, input, init);
        if ((url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) &&
            isSafeToIntercept(url) &&
            response.ok) {
            if (!isJsonResponse(response.headers.get('content-type'))) {
                return response;
            }
            const customModels = await getCustomModelsForInjection();
            if (customModels && customModels.length > 0) {
                try {
                    const cloned = response.clone();
                    const text = await cloned.text();
                    if (text && text.length > 10) {
                        const parsed = JSON.parse(text);
                        if (!injectMissingCustomModels(parsed, customModels))
                            return response;
                        return new Response(JSON.stringify(parsed), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    }
                }
                catch {
                    /* ignore parse errors */
                }
            }
        }
        return response;
    };
    function hashCodeStr(s) {
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
//# sourceMappingURL=customPreload.js.map