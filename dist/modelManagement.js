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
exports.checkedUrl = checkedUrl;
exports.requestJson = requestJson;
exports.modelListUrl = modelListUrl;
exports.createModelManager = createModelManager;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const modelStore_1 = require("./modelStore");
const providers_1 = require("./providers");
const googleOAuth_1 = require("./googleOAuth");
const googleOnboarding_1 = require("./googleOnboarding");
const generationProbe_1 = require("./generationProbe");
const schemaValidator_1 = require("./schemaValidator");
const googleAccounts_1 = require("./googleAccounts");
function checkedUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Use an HTTP(S) URL without embedded credentials');
    url.hash = '';
    return url;
}
/** Small bounded requests, no credential forwarding across redirects. */
function requestJson(urlValue, headers = {}, allowUnauthorized = false) {
    const url = checkedUrl(urlValue);
    return new Promise((resolve, reject) => {
        let completed = false;
        let timer;
        const finish = (error, value) => {
            if (completed)
                return;
            completed = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve(value);
        };
        const req = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'GET',
            headers: { Accept: 'application/json', ...headers },
            rejectUnauthorized: !allowUnauthorized,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) {
                    finish(new Error('Response exceeds 2 MB'));
                    req.destroy();
                    res.destroy();
                }
                else
                    chunks.push(chunk);
            });
            res.on('error', (error) => finish(error));
            res.on('aborted', () => finish(new Error('Server closed the response early')));
            res.on('end', () => {
                const status = res.statusCode || 502;
                const text = Buffer.concat(chunks).toString('utf8');
                try {
                    finish(undefined, { status, data: text ? JSON.parse(text) : {} });
                }
                catch {
                    finish(undefined, { status, data: null });
                }
            });
        });
        timer = setTimeout(() => {
            finish(new Error('Connection timed out after 10 seconds'));
            req.destroy();
        }, 10000);
        req.on('error', (error) => finish(error));
        req.end();
    });
}
function statusError(status, workersAi = false) {
    if (workersAi && (status === 401 || status === 403))
        return `Cloudflare authentication failed — check the Account ID and API token's Workers AI Read or Write permission (HTTP ${status}). Use the Workers AI API token template for generation.`;
    if (workersAi && (status === 404 || status === 405))
        return `Cloudflare model catalog is unavailable (HTTP ${status}). Check the account API URL. You can enter a model ID manually; generation was not tested.`;
    const messages = {
        401: 'Authentication rejected — check the API key',
        403: 'Access denied — check provider permissions',
        404: 'Model listing endpoint not found — check the API URL',
        405: 'Provider does not support model listing',
        429: 'Rate limited — check provider quota and retry later',
    };
    return `${messages[status] || 'Provider request failed'} (HTTP ${status})`;
}
function modelListUrl(apiUrl, format, provider) {
    const url = checkedUrl(apiUrl);
    url.search = '';
    const workersPath = (0, providers_1.workersAiAccountPath)(apiUrl, provider);
    if (workersPath) {
        url.pathname = `${workersPath}/models/search`;
        url.searchParams.set('format', 'openrouter');
        url.searchParams.set('task', 'Text Generation');
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', '1');
        return url.toString();
    }
    if ((0, providers_1.isOpencodeEndpoint)(apiUrl, provider)) {
        const legacy = /^\/zen(?:\/|$)/.test(url.pathname);
        const go = /^\/(?:zen|inference)\/go(?:\/|$)/.test(url.pathname) || provider === 'opencode-go';
        url.pathname = `/${legacy ? 'zen' : 'inference'}${go ? '/go' : ''}/v1/models`;
        return url.toString();
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    pathname = pathname
        .replace(/\/(chat\/completions|completions|responses|messages)$/, '')
        .replace(/\/models(?:\/.*)?$/, '');
    if (provider === 'dashscope') {
        url.pathname = `${pathname.replace(/\/(?:compatible-mode\/)?v1$/, '')}/api/v1/models`;
        url.searchParams.set('capabilities', 'TG');
        url.searchParams.set('page_no', '1');
        url.searchParams.set('page_size', '100');
        return url.toString();
    }
    if (provider === 'fireworks') {
        url.pathname = `${pathname.replace(/\/(?:inference\/)?v1$/, '')}/v1/accounts/fireworks/models`;
        url.searchParams.set('pageSize', '200');
        return url.toString();
    }
    if (format === 'google') {
        if (!/\/v1(?:beta)?$/.test(pathname))
            pathname += '/v1beta';
    }
    else if (!/(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(pathname))
        pathname += '/v1';
    url.pathname = `${pathname}/models`;
    if (provider === 'siliconflow')
        url.searchParams.set('sub_type', 'chat');
    return url.toString();
}
function parseModels(data, provider) {
    if (!data || typeof data !== 'object')
        throw new Error('Provider did not return a JSON model list');
    const root = data;
    if (provider === 'workers-ai' && root.success === false)
        throw new Error('Cloudflare model catalog request failed — check the Account ID and Workers AI token permissions');
    const nativeWorkers = provider === 'workers-ai' && Array.isArray(root.result);
    const items = nativeWorkers
        ? root.result
        : Array.isArray(data)
            ? data
            : Array.isArray(root.data)
                ? root.data
                : root.models || root.output?.models;
    if (!Array.isArray(items))
        throw new Error('Provider response has no model list');
    const positiveLimit = (...values) => values.find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1000000000);
    const seen = new Set();
    return items
        .filter((item) => item && typeof item === 'object')
        .filter((item) => !nativeWorkers || !item.task?.name || item.task.name === 'Text Generation')
        .filter((item) => provider !== 'together' || item.type === 'chat')
        .filter((item) => provider !== 'fireworks' ||
        (item.supportsServerless !== false &&
            (!item.state || item.state === 'READY') &&
            item.kind !== 'EMBEDDING_MODEL'))
        .filter((item) => !['embedding', 'embeddings', 'image', 'audio', 'rerank', 'moderation'].includes(item.type))
        .filter((item) => !Array.isArray(item.architecture?.output_modalities) || item.architecture.output_modalities.includes('text'))
        .map((item) => {
        const providerLimits = Array.isArray(item.providers)
            ? item.providers.map((value) => positiveLimit(value?.context_length))
            : [];
        const contextWindow = positiveLimit(item.contextWindow, item.context_window, item.context_length, item.context_size, item.inputTokenLimit, item.top_provider?.context_length, item.model_info?.context_window, providerLimits.length && providerLimits.every((value) => typeof value === 'number')
            ? Math.min(...providerLimits)
            : undefined);
        const maxOutputTokens = positiveLimit(item.maxOutputTokens, item.max_output_tokens, item.max_completion_tokens, item.outputTokenLimit, item.top_provider?.max_completion_tokens);
        const supportsVision = typeof item.supportsVision === 'boolean'
            ? item.supportsVision
            : [item.input_modalities, item.architecture?.input_modalities, item.inference_metadata?.request_modality]
                .find(Array.isArray)
                ?.some((value) => typeof value === 'string' && value.toLowerCase() === 'image');
        const supportsThinking = typeof item.supportsThinking === 'boolean'
            ? item.supportsThinking
            : Array.isArray(item.supported_parameters)
                ? item.supported_parameters.some((value) => value === 'reasoning' || value === 'reasoning_effort')
                : undefined;
        return {
            id: String(nativeWorkers ? item.name || '' : item.id || item.model || item.name || '').replace(/^models\//, ''),
            displayName: String(item.displayName || item.display_name || item.title || item.name || item.id || item.model || ''),
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(supportsVision !== undefined ? { supportsVision } : {}),
            ...(supportsThinking !== undefined ? { supportsThinking } : {}),
        };
    })
        .filter((item) => {
        if (!item.id || seen.has(item.id))
            return false;
        seen.add(item.id);
        return true;
    });
}
function createModelManager(directory, codec, openExternal, overrides = {}) {
    const dependencies = {
        loginGoogleAccount: googleOAuth_1.loginGoogleAccount,
        refreshGoogleAccount: googleAccounts_1.refreshGoogleAccount,
        fetchGoogleQuota: googleAccounts_1.fetchGoogleQuota,
        prepareGoogleAccount: googleOnboarding_1.prepareGoogleAccount,
        now: Date.now,
        ...overrides,
    };
    const pending = new Map();
    let loginController;
    function pendingAccount(id) {
        for (const [key, value] of pending)
            if (value.expiresAt <= dependencies.now())
                pending.delete(key);
        return pending.get(id)?.account;
    }
    const store = new modelStore_1.ModelStore(path.join(directory, 'custom_models.json'), codec, (id) => {
        const account = pendingAccount(id);
        return account ? { ...account } : undefined;
    });
    function persistGoogleAccount(modelName, account, previous, includePreparation = false, requireUnchangedCredentials = includePreparation) {
        const raw = store.read().find((item) => item.name === modelName);
        if (!raw || !Array.isArray(raw.googleAccounts))
            return false;
        const stored = raw.googleAccounts.find((item) => item.id === account.id);
        if (!stored)
            return false;
        if (previous) {
            const secret = (value) => raw.encryptedGoogleAccounts ? (0, modelStore_1.decodeSecret)(value, codec) : value || '';
            if (stored.clientId !== previous.clientId ||
                (secret(stored.refreshToken) || secret(stored.accessToken)) !==
                    (previous.refreshToken || previous.accessToken || ''))
                return false;
            if (includePreparation &&
                ['project', 'cloudCodeEndpoint', 'authMode'].some((field) => stored[field] !== previous[field]))
                return false;
            if (requireUnchangedCredentials &&
                ['accessToken', 'refreshToken', 'clientSecret'].some((field) => secret(stored[field]) !== (previous[field] || '')))
                return false;
        }
        const model = (0, modelStore_1.redactModel)(raw);
        if (!Array.isArray(model.googleAccounts))
            return false;
        const index = model.googleAccounts.findIndex((item) => item.id === account.id);
        if (index < 0)
            return false; // Account or model removed while a request was in flight.
        model.googleAccounts[index] = {
            ...model.googleAccounts[index],
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            ...(includePreparation
                ? { project: account.project, cloudCodeEndpoint: account.cloudCodeEndpoint, authMode: account.authMode }
                : {}),
        };
        store.save(model);
        return true;
    }
    (0, googleAccounts_1.configureGoogleAccountPersistence)((modelName, account, previous) => {
        persistGoogleAccount(modelName, account, previous);
    });
    function saveModel(model) {
        const previous = store.read().find((saved) => saved.name === (model.originalName || model.name));
        store.save(model);
        const current = store.read().find((saved) => saved.name === model.name);
        for (const account of Array.isArray(current?.googleAccounts) ? current.googleAccounts : []) {
            const old = (Array.isArray(previous?.googleAccounts) ? previous.googleAccounts : []).find((value) => value.id === account.id);
            if (!old)
                continue;
            const secretChanged = ['accessToken', 'refreshToken', 'clientSecret'].some((field) => (current?.encryptedGoogleAccounts ? (0, modelStore_1.decodeSecret)(account[field], codec) : account[field] || '') !==
                (previous?.encryptedGoogleAccounts ? (0, modelStore_1.decodeSecret)(old[field], codec) : old[field] || ''));
            if (secretChanged || ['clientId', 'project', 'authMode', 'cloudCodeEndpoint'].some((field) => old[field] !== account[field]))
                (0, googleAccounts_1.resetGoogleAccountState)(account.id);
        }
        return { success: true };
    }
    function resolveGoogleAccount(input) {
        const savedModel = input.modelName ? store.read().find((item) => item.name === input.modelName) : undefined;
        const id = input.accountId || input.account?.id;
        const saved = Array.isArray(savedModel?.googleAccounts)
            ? savedModel.googleAccounts.find((item) => item.id === id)
            : undefined;
        const temporary = id ? pendingAccount(id) : undefined;
        const account = { ...(saved || temporary || {}), ...(input.account || {}) };
        if (!account.id)
            throw new Error('Select a Google account first');
        for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
            const supplied = input.account?.[field];
            if (supplied && !(0, modelStore_1.isMaskedSecret)(supplied) && supplied !== saved?.[field]) {
                if (/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(supplied))
                    throw new Error('Enter fresh Google credentials instead of a machine-encrypted value');
                account[field] = supplied;
            }
            else if (saved?.[field])
                account[field] = savedModel?.encryptedGoogleAccounts ? (0, modelStore_1.decodeSecret)(saved[field], codec) : saved[field];
            else
                account[field] = temporary?.[field];
        }
        return account;
    }
    function maskedGoogleAccount(account) {
        const masked = (0, modelStore_1.redactModel)({
            name: '',
            provider: '',
            apiUrl: '',
            externalModelName: '',
            googleAccounts: [account],
        });
        return masked.googleAccounts[0];
    }
    function rememberGoogleAccount(account) {
        pendingAccount(account.id);
        if (!pending.has(account.id) && pending.size >= 20)
            pending.delete(pending.keys().next().value);
        pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
    }
    function googleModels() {
        return store.list().filter((model) => model.provider === 'google-cloudcode');
    }
    function updateGoogleModels(models, ids) {
        if (!models.length)
            throw new Error('No saved Google model contains this account. Reload the account list.');
        // ModelStore validates every entry before one atomic write; masked unrelated
        // credentials are preserved and partial updates cannot split a shared pool.
        store.import(models);
        for (const id of new Set(ids))
            (0, googleAccounts_1.resetGoogleAccountState)(id);
        return { success: true, count: models.length };
    }
    const gatewayFile = path.join(directory, 'gateway_connection.json');
    function gatewayRaw() {
        try {
            return JSON.parse(fs.readFileSync(gatewayFile, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return { url: 'http://127.0.0.1:51000', dashboardUrl: 'http://127.0.0.1:51001', token: '' };
            throw error;
        }
    }
    function resolveGateway(input) {
        const previous = gatewayRaw();
        const connection = input ? { ...previous, ...input } : previous;
        connection.url = checkedUrl(connection.url).toString().replace(/\/$/, '');
        if (input &&
            checkedUrl(connection.url).origin !== checkedUrl(previous.url).origin &&
            (!input.token || (0, modelStore_1.isMaskedSecret)(input.token))) {
            throw new Error('Enter the token for the new gateway address');
        }
        if (connection.dashboardUrl)
            connection.dashboardUrl = checkedUrl(connection.dashboardUrl).toString();
        connection.token =
            (0, modelStore_1.isMaskedSecret)(connection.token) || connection.token === undefined
                ? (0, modelStore_1.decodeSecret)(previous.token, codec)
                : (0, modelStore_1.decodeSecret)(connection.token, codec);
        if (!connection.token)
            throw new Error('Gateway access token is required. Run gateway setup to obtain it.');
        return connection;
    }
    function resolveProbe(input) {
        const stored = input.name ? store.read().find((model) => model.name === input.name) : undefined;
        const model = { ...(stored || {}), ...input };
        if (stored &&
            (stored.provider !== model.provider || checkedUrl(stored.apiUrl).origin !== checkedUrl(model.apiUrl).origin)) {
            if ((stored.apiKey &&
                stored.apiKey !== 'none' &&
                (!input.apiKey || (0, modelStore_1.isMaskedSecret)(input.apiKey) || input.apiKey === stored.apiKey)) ||
                Object.values(model.customHeaders || {}).some(modelStore_1.isMaskedSecret) ||
                (input.customHeaders === undefined && Object.keys(model.customHeaders || {}).length)) {
                throw new Error('Enter fresh credentials when changing the provider or server address');
            }
        }
        if ((0, modelStore_1.isMaskedSecret)(model.apiKey) || model.apiKey === undefined)
            model.apiKey = stored?.apiKey;
        if ((0, modelStore_1.isMaskedSecret)(model.apiKey))
            throw new Error('Enter an API key or select a saved model');
        model.apiKey = (0, modelStore_1.decodeSecret)(model.apiKey, codec);
        const savedHeaders = (stored?.customHeaders || {});
        model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders || {}).map(([key, value]) => {
            const saved = (0, modelStore_1.isMaskedSecret)(value) || value === savedHeaders[key];
            const resolved = (0, modelStore_1.isMaskedSecret)(value) ? savedHeaders[key] : value;
            if (!resolved || (0, modelStore_1.isMaskedSecret)(resolved))
                throw new Error(`Enter a value for header ${key}`);
            return [key, saved && stored?.encryptedHeaders ? (0, modelStore_1.decodeSecret)(resolved, codec) : resolved];
        }));
        return model;
    }
    async function discoverModels(input) {
        if (input.provider === 'google-cloudcode') {
            const saved = input.name ? store.read().find((model) => model.name === input.name) : undefined;
            const accounts = input.googleAccounts || saved?.googleAccounts;
            const selected = accounts?.find((account) => account.enabled !== false);
            if (!selected)
                throw new Error('Add or enable a Google account before discovering models');
            const previous = resolveGoogleAccount({ modelName: input.name, account: selected });
            previous.project || (previous.project = input.googleProject || saved?.googleProject);
            const account = await dependencies.refreshGoogleAccount(previous);
            // Persist refreshed tokens only if their source credentials are still current.
            if (input.name)
                persistGoogleAccount(input.name, account, previous);
            else if (pending.has(account.id))
                pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
            return { success: true, models: await (0, googleAccounts_1.fetchGoogleModels)(account, input.apiUrl), status: 200 };
        }
        const model = resolveProbe(input);
        const workersAi = !!(0, providers_1.workersAiAccountPath)(model.apiUrl, model.provider);
        const format = (0, providers_1.resolveApiFormat)(model.provider, model.apiFormat);
        if (workersAi && format !== 'openai')
            throw new Error('Cloudflare Workers AI requires the OpenAI compatible API format');
        const authenticationHeaders = Object.fromEntries(Object.entries(model.customHeaders || {}).map(([key, value]) => [
            key.toLowerCase(),
            typeof value === 'string' ? value.trim() : '',
        ]));
        if (workersAi &&
            (!model.apiKey || model.apiKey === 'none') &&
            !authenticationHeaders.authorization &&
            !(authenticationHeaders['x-auth-key'] && authenticationHeaders['x-auth-email']))
            throw new Error('Enter a Cloudflare Workers AI API token or authentication headers');
        const headers = {};
        if ((0, providers_1.isOpencodeEndpoint)(model.apiUrl, model.provider)) {
            if (model.apiKey && model.apiKey !== 'none')
                headers.Authorization = `Bearer ${model.apiKey}`;
            headers['User-Agent'] = providers_1.OPENCODE_USER_AGENT;
        }
        else if (model.provider === 'fireworks') {
            if (model.apiKey)
                headers.Authorization = `Bearer ${model.apiKey}`;
        }
        else if (format === 'anthropic') {
            headers['anthropic-version'] = '2023-06-01';
            if (model.apiKey)
                headers['x-api-key'] = model.apiKey;
        }
        else if (format === 'google') {
            if (model.apiKey)
                headers['x-goog-api-key'] = model.apiKey;
        }
        else if (model.apiKey && (!workersAi || model.apiKey !== 'none'))
            headers.Authorization = `Bearer ${model.apiKey}`;
        for (const [key, value] of Object.entries(model.customHeaders || {})) {
            if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
                throw new Error('Reserved HTTP header');
            http.validateHeaderName(key);
            http.validateHeaderValue(key, value);
            headers[key] = value;
        }
        const listUrl = new URL(modelListUrl(model.apiUrl, format, model.provider));
        const models = new Map();
        const cursors = new Set();
        const workersPages = new Set();
        const deadline = Date.now() + 30000;
        let received = 0;
        for (let page = 1; page <= 50; page++) {
            if (Date.now() >= deadline)
                throw new Error('Model discovery exceeded its 30-second time budget');
            const response = await requestJson(listUrl.toString(), headers, model.allowUnauthorized);
            if (response.status < 200 || response.status >= 300)
                throw Object.assign(new Error(statusError(response.status, workersAi)), { status: response.status });
            for (const found of parseModels(response.data, workersAi ? 'workers-ai' : model.provider))
                models.set(found.id, found);
            if (models.size > 10000)
                throw new Error('Model catalog exceeds 10000 entries');
            const data = response.data;
            if (workersAi) {
                const catalog = response.data;
                const items = catalog.result || catalog.data;
                const info = catalog.result_info;
                if (info &&
                    Object.values(info).some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))
                    throw new Error('Cloudflare returned invalid model pagination');
                if (info?.page !== undefined && info.page !== page)
                    throw new Error('Cloudflare returned an unexpected model page');
                const signature = JSON.stringify(items);
                if (items.length && workersPages.has(signature))
                    throw new Error('Cloudflare repeated a model catalog page');
                workersPages.add(signature);
                received += items.length;
                if (received > 10000)
                    throw new Error('Model catalog exceeds 10000 entries');
                const hasMore = info?.total_count !== undefined
                    ? received < info.total_count
                    : info?.total_pages !== undefined
                        ? page < info.total_pages
                        : items.length >= (info?.per_page || 100);
                if (hasMore) {
                    if (!items.length)
                        throw new Error('Cloudflare returned an incomplete model catalog');
                    listUrl.searchParams.set('page', String(page + 1));
                    continue;
                }
            }
            else if (model.provider === 'dashscope' && Array.isArray(data.output?.models)) {
                received += data.output.models.length;
                const total = data.output.total;
                if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 && received < total) {
                    if (!data.output.models.length)
                        throw new Error('Provider returned an incomplete model catalog');
                    listUrl.searchParams.set('page_no', String(page + 1));
                    continue;
                }
                if (total === undefined && data.output.models.length === 100) {
                    listUrl.searchParams.set('page_no', String(page + 1));
                    continue;
                }
            }
            else if (model.provider === 'fireworks' && data.nextPageToken) {
                const token = data.nextPageToken;
                if (typeof token !== 'string' || token.length > 4096 || cursors.has(token))
                    throw new Error('Provider returned an invalid model page token');
                cursors.add(token);
                listUrl.searchParams.set('pageToken', token);
                continue;
            }
            return { success: true, models: [...models.values()], status: response.status };
        }
        throw new Error('Model discovery exceeded the maximum number of pages');
    }
    async function gatewayModels(input) {
        const connection = resolveGateway(input);
        const response = await requestJson(`${connection.url}/models`, { Authorization: `Bearer ${connection.token}` });
        if (response.status !== 200)
            throw new Error(statusError(response.status));
        return { connection, models: parseModels(response.data) };
    }
    return {
        store,
        saveModel,
        presets: () => providers_1.PROVIDERS,
        discoverModels,
        createEffortVariants(name) {
            const source = store.list().find((model) => model.name === name);
            if (!source)
                throw new Error('Original model no longer exists');
            if (source.supportsThinking === false)
                throw new Error('This model is configured without reasoning support');
            const names = new Set(store.list().map((model) => model.name));
            const format = (0, providers_1.resolveApiFormat)(source.provider, source.apiFormat);
            const copies = ['low', 'medium', 'high'].map((effort, index) => {
                let target = `${name}-${effort}`;
                let suffix = 2;
                while (names.has(target))
                    target = `${name}-${effort}-${suffix++}`;
                names.add(target);
                const copy = {
                    ...source,
                    name: target,
                    copyFrom: name,
                    displayName: `${source.displayName || source.externalModelName || source.name} (${effort})`,
                    reasoningEffort: effort,
                };
                if (format !== 'openai') {
                    const budget = [1024, 4096, 8192][index];
                    copy.thinkingBudget = budget;
                    copy.maxOutputTokens = Math.max(Number(source.maxOutputTokens) || 16384, budget + 1024);
                    if (source.contextWindow && Number(source.contextWindow) <= Number(copy.maxOutputTokens))
                        throw new Error('The configured context window is too small for these thinking budgets. Adjust the model limits first.');
                }
                const validation = (0, schemaValidator_1.validateCustomModel)(copy);
                if (!validation.valid)
                    throw new Error(validation.error);
                return copy;
            });
            for (const copy of copies)
                store.save(copy);
            return { success: true, count: copies.length };
        },
        async googleLogin(options) {
            if (loginController)
                throw new Error('A Google login is already in progress');
            const controller = new AbortController();
            loginController = controller;
            try {
                let account = await dependencies.loginGoogleAccount({
                    authMode: options.authMode,
                    clientId: options.clientId,
                    clientSecret: options.clientSecret,
                    label: options.label,
                    signal: controller.signal,
                }, openExternal);
                if (controller.signal.aborted)
                    throw new Error('Google login cancelled');
                if (options.authMode === 'antigravity')
                    account = await dependencies.prepareGoogleAccount({ ...account, authMode: 'antigravity' }, { signal: controller.signal, allowOnboard: true });
                if (controller.signal.aborted)
                    throw new Error('Google login cancelled');
                rememberGoogleAccount(account);
                return { success: true, account: maskedGoogleAccount(account) };
            }
            finally {
                if (loginController === controller)
                    loginController = undefined;
            }
        },
        googleLoginCancel() {
            loginController?.abort();
            return { success: true };
        },
        googlePoolStatus() {
            return { success: true, accounts: (0, googleAccounts_1.getGooglePoolStatus)() };
        },
        googleLinkAccount(input) {
            const account = pendingAccount(input.accountId);
            if (!account)
                throw new Error('This login has expired. Sign in again.');
            const changed = [];
            const resetIds = [account.id];
            for (const model of googleModels().filter((model) => model.name === input.modelName)) {
                const accounts = Array.isArray(model.googleAccounts) ? model.googleAccounts : [];
                const index = accounts.findIndex((existing) => input.replaceAccountId
                    ? existing.id === input.replaceAccountId
                    : existing.id === account.id || (!!account.email && existing.email?.toLowerCase() === account.email.toLowerCase()));
                if (input.replaceAccountId && index < 0)
                    continue;
                if (index >= 0) {
                    const previous = accounts[index];
                    if (previous.email && account.email && previous.email.toLowerCase() !== account.email.toLowerCase())
                        throw new Error('The signed-in email does not match this account. Add it as a separate account instead.');
                    // The renderer receives masked secrets. Resolve the fresh credentials
                    // using the pending login ID before preserving the saved account ID.
                    accounts[index] = { ...account, refreshToken: account.refreshToken || '', clientSecret: account.clientSecret || '', id: previous.id, label: previous.label || account.label, enabled: previous.enabled };
                    resetIds.push(previous.id);
                }
                else
                    accounts.push({ ...account, enabled: true });
                changed.push({ ...model, googleAccounts: accounts });
            }
            return updateGoogleModels(changed, resetIds);
        },
        googleSelectAccount(input) {
            const changed = [];
            for (const model of googleModels()) {
                if (model.name !== input.modelName)
                    continue;
                const pool = { ...(model.googlePool || {}) };
                if (pool.preferredAccountId === input.accountId || !input.accountId) {
                    delete pool.preferredAccountId;
                    changed.push({ ...model, googlePool: Object.keys(pool).length > 0 ? pool : undefined });
                }
                else if (Array.isArray(model.googleAccounts) &&
                    model.googleAccounts.some((account) => account.id === input.accountId && account.enabled !== false)) {
                    pool.preferredAccountId = input.accountId;
                    changed.push({ ...model, googlePool: pool });
                }
            }
            return updateGoogleModels(changed, []);
        },
        googleRemoveAccount(input) {
            const changed = [];
            for (const model of googleModels()) {
                if (model.name !== input.modelName)
                    continue;
                if (!Array.isArray(model.googleAccounts) || !model.googleAccounts.some((account) => account.id === input.accountId))
                    continue;
                const accounts = model.googleAccounts.filter((account) => account.id !== input.accountId);
                const pool = { ...(model.googlePool || {}) };
                if (pool.preferredAccountId === input.accountId)
                    delete pool.preferredAccountId;
                changed.push({ ...model, googleAccounts: accounts, googlePool: pool,
                    ...(!accounts.some((account) => account.enabled !== false) ? { enabled: false } : {}) });
            }
            const result = updateGoogleModels(changed, []);
            if (!googleModels().some((model) => Array.isArray(model.googleAccounts) && model.googleAccounts.some((account) => account.id === input.accountId))) {
                (0, googleAccounts_1.resetGoogleAccountState)(input.accountId);
                pending.delete(input.accountId);
            }
            return result;
        },
        async googlePrepareAccount(input) {
            if (loginController)
                throw new Error('A Google login or account preparation is already in progress');
            const controller = new AbortController();
            loginController = controller;
            try {
                let previous = resolveGoogleAccount(input);
                const saved = input.modelName ? store.read().find((model) => model.name === input.modelName) : undefined;
                const savedAccount = saved?.googleAccounts?.find((account) => account.id === previous.id);
                if (savedAccount) {
                    const metadataChanged = ['clientId', 'project', 'authMode', 'cloudCodeEndpoint'].some((field) => savedAccount[field] !== previous[field]);
                    const credentialsChanged = ['accessToken', 'refreshToken', 'clientSecret'].some((field) => {
                        const raw = savedAccount[field];
                        const value = raw && saved?.encryptedGoogleAccounts ? (0, modelStore_1.decodeSecret)(raw, codec) : raw;
                        return (value || '') !== (previous[field] || '');
                    });
                    if (metadataChanged || credentialsChanged)
                        throw new Error('Save your edited account credentials and settings before preparing this account.');
                }
                const refreshed = await dependencies.refreshGoogleAccount(previous);
                if (input.modelName && savedAccount) {
                    const tokensChanged = ['accessToken', 'refreshToken', 'expiresAt'].some((field) => refreshed[field] !== previous[field]);
                    // A successful refresh may rotate the only usable refresh token. Retain it even if
                    // preparation subsequently fails or is cancelled, without overwriting account edits.
                    if (tokensChanged && !persistGoogleAccount(input.modelName, refreshed, previous, false, true))
                        throw new Error('This account changed while preparation was running. Reload it and prepare again.');
                    previous = {
                        ...previous,
                        accessToken: refreshed.accessToken,
                        refreshToken: refreshed.refreshToken,
                        expiresAt: refreshed.expiresAt,
                    };
                    const current = resolveGoogleAccount({ modelName: input.modelName, accountId: previous.id });
                    if (['clientId', 'project', 'authMode', 'cloudCodeEndpoint'].some((field) => current[field] !== previous[field]) ||
                        ['accessToken', 'refreshToken', 'clientSecret'].some((field) => (current[field] || '') !== (previous[field] || '')))
                        throw new Error('This account changed while preparation was running. Reload it and prepare again.');
                }
                if (controller.signal.aborted)
                    throw new Error('Google account preparation cancelled');
                const account = await dependencies.prepareGoogleAccount(refreshed, {
                    signal: controller.signal,
                    allowOnboard: input.allowOnboard === true,
                });
                if (controller.signal.aborted)
                    throw new Error('Google account preparation cancelled');
                if (input.modelName && savedAccount && !persistGoogleAccount(input.modelName, account, previous, true))
                    throw new Error('This account changed while preparation was running. Reload it and prepare again.');
                rememberGoogleAccount(account);
                (0, googleAccounts_1.resetGoogleAccountState)(account.id);
                return {
                    success: true,
                    account: maskedGoogleAccount(account),
                    message: 'Account project prepared. Save the model, then test model discovery and generation.',
                };
            }
            finally {
                if (loginController === controller)
                    loginController = undefined;
            }
        },
        async googleTestAccount(input) {
            const endpoint = input.modelName
                ? store.read().find((model) => model.name === input.modelName)?.apiUrl
                : undefined;
            const previous = resolveGoogleAccount(input);
            const account = await dependencies.refreshGoogleAccount(previous);
            if (input.modelName)
                persistGoogleAccount(input.modelName, account, previous);
            else if (pending.has(account.id))
                pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
            const quota = await dependencies.fetchGoogleQuota(account, endpoint);
            return { success: true, quota };
        },
        async testModel(input) {
            const result = await discoverModels(input);
            const selected = input.externalModelName?.replace(/^models\//, '');
            if (selected && !result.models.some((model) => model.id === selected)) {
                return {
                    success: false,
                    status: result.status,
                    error: `Endpoint authenticated, but model "${selected}" was not listed. Generation was not tested.`,
                };
            }
            return {
                success: true,
                status: result.status,
                message: `Model listing verified (${result.models.length} models). Generation was not tested.`,
            };
        },
        async testGeneration(input) {
            const probe = resolveProbe(input);
            if (!probe.externalModelName?.trim())
                throw new Error('Enter the provider model ID before testing generation');
            if (probe.provider === 'google-cloudcode') {
                const selected = probe.googleAccounts?.find((account) => account.enabled !== false);
                if (!selected)
                    throw new Error('Add or enable a Google account before testing generation');
                probe.googleAccounts = [resolveGoogleAccount({ modelName: probe.name, account: selected })];
            }
            const model = { ...probe, name: probe.name || 'models/generation-test', enabled: true };
            const validation = (0, schemaValidator_1.validateCustomModel)(model);
            if (!validation.valid)
                throw new Error(validation.error);
            return (0, generationProbe_1.runGenerationProbe)(model);
        },
        async discoverLocal() {
            const targets = [
                ['ollama', 11434],
                ['lmstudio', 1234],
                ['llamacpp', 8080],
                ['vllm', 8000],
                ['textgen', 5000],
                ['tabby', 5001],
                ['localai', 8081],
                ['litellm', 4000],
                ['aphrodite', 2242],
            ];
            const results = await Promise.allSettled(targets.map(async ([provider, port]) => {
                const apiUrl = `http://127.0.0.1:${port}/v1`;
                const found = await discoverModels({ provider, apiUrl, apiFormat: 'openai', apiKey: '' });
                return { provider: (0, providers_1.getProvider)(provider)?.id || 'custom', apiUrl, models: found.models };
            }));
            return {
                success: true,
                servers: results
                    .filter((r) => r.status === 'fulfilled')
                    .map((r) => r.value),
            };
        },
        getGateway() {
            const connection = gatewayRaw();
            return { ...connection, token: connection.token ? '********' : '' };
        },
        saveGateway(input) {
            const connection = resolveGateway(input);
            (0, modelStore_1.writeJsonAtomic)(gatewayFile, { ...connection, token: codec.encryptString(connection.token) });
            return { success: true };
        },
        async testGateway(input) {
            const { models } = await gatewayModels(input);
            return { success: true, message: `Gateway authenticated; ${models.length} model aliases available`, models };
        },
        async importGatewayModels(input) {
            const { connection, models } = await gatewayModels(input);
            if (!models.length)
                throw new Error('Gateway has no model aliases. Add them in the dashboard first.');
            const incoming = models.map((model) => ({
                name: `models/gateway-${model.id}`,
                externalModelName: model.id,
                displayName: `${model.displayName} (Gateway)`,
                provider: 'google',
                apiFormat: 'google',
                gateway: true,
                contextWindow: model.contextWindow ?? 128000,
                supportsVision: model.supportsVision ?? false,
                supportsThinking: model.supportsThinking ?? false,
                ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
                apiUrl: `${connection.url}/v1beta`,
                apiKey: connection.token,
                enabled: true,
            }));
            const count = store.import({ models: incoming });
            (0, modelStore_1.writeJsonAtomic)(gatewayFile, { ...connection, token: codec.encryptString(connection.token) });
            return { success: true, count };
        },
        async openDashboard() {
            const connection = gatewayRaw();
            if (!connection.dashboardUrl)
                throw new Error('Set the dashboard URL first');
            await openExternal(checkedUrl(connection.dashboardUrl).toString());
            return { success: true };
        },
    };
}
//# sourceMappingURL=modelManagement.js.map