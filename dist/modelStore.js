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
exports.ModelStore = void 0;
exports.normalizeModelConfig = normalizeModelConfig;
exports.readModelConfig = readModelConfig;
exports.writeJsonAtomic = writeJsonAtomic;
exports.isMaskedSecret = isMaskedSecret;
exports.decodeSecret = decodeSecret;
exports.redactModel = redactModel;
/** Backward-compatible model storage shared by the addon and proxy. */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const schemaValidator_1 = require("./schemaValidator");
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected an object');
    return value;
}
/** Accept flat legacy files and provider-group exports without losing model overrides. */
function normalizeModelConfig(payload) {
    let value = payload;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text.length > 4 * 1024 * 1024)
            throw new Error('Model import exceeds 4 MB');
        try {
            value = JSON.parse(text);
        }
        catch {
            value = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
        }
    }
    let entries;
    if (Array.isArray(value))
        entries = value;
    else {
        const root = object(value);
        if (Array.isArray(root.models))
            entries = root.models;
        else if (Array.isArray(root.providers)) {
            entries = root.providers.flatMap((entry) => {
                const provider = object(entry);
                if (!Array.isArray(provider.models))
                    throw new Error('Provider models must be an array');
                return provider.models.map((item) => {
                    const model = typeof item === 'string' ? { id: item } : object(item);
                    const external = String(model.externalModelName || model.id || model.name || '');
                    const { models: _models, id: _id, name: _name, ...defaults } = provider;
                    return {
                        ...defaults,
                        ...model,
                        name: model.name || `models/${String(provider.id || provider.provider || 'custom')}-${external}`,
                        provider: model.provider || provider.provider || 'custom',
                        externalModelName: external,
                        enabled: provider.enabled !== false && model.enabled !== false,
                    };
                });
            });
        }
        else
            throw new Error('Configuration must contain a models or providers array');
    }
    if (entries.length > 5000)
        throw new Error('Too many models (maximum 5000)');
    return entries.map((entry) => {
        const model = { ...object(entry) };
        if (model.extraHeaders && !model.customHeaders)
            model.customHeaders = model.extraHeaders;
        if (model.useRawBaseUrl !== undefined && model.rawUrl === undefined)
            model.rawUrl = model.useRawBaseUrl;
        if (model.supportsImages !== undefined && model.supportsVision === undefined)
            model.supportsVision = model.supportsImages;
        if (typeof model.fallbackModel === 'string' && !model.fallbackModels)
            model.fallbackModels = [model.fallbackModel];
        delete model.extraHeaders;
        delete model.useRawBaseUrl;
        delete model.supportsImages;
        model.externalModelName || (model.externalModelName = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '');
        return model;
    });
}
function readModelConfig(filename) {
    try {
        return normalizeModelConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary))
            fs.unlinkSync(temporary);
    }
}
function isMaskedSecret(value) {
    return typeof value === 'string' && (value === '********' || value.startsWith('***') || value.includes('...'));
}
function decodeSecret(value, codec) {
    if (!value || value === 'none')
        return '';
    const decoded = codec.decryptString(value);
    if (!decoded || decoded.startsWith('DECRYPTION_FAILED'))
        throw new Error('Saved key cannot be decrypted on this machine. Enter it again.');
    return decoded;
}
function redactModel(model) {
    const result = { ...model };
    result.apiKey = model.apiKey && model.apiKey !== 'none' ? '********' : '';
    if (model.customHeaders && typeof model.customHeaders === 'object') {
        result.customHeaders = Object.fromEntries(Object.keys(model.customHeaders).map((key) => [key, '********']));
    }
    if (Array.isArray(model.googleAccounts)) {
        result.googleAccounts = model.googleAccounts.map((account) => {
            const masked = { ...account };
            for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                if (masked[field])
                    masked[field] = '********';
            return masked;
        });
    }
    return result;
}
/** All writes are synchronous atomic read/modify/write operations, including bulk imports. */
class ModelStore {
    constructor(filename, codec, pendingAccount) {
        this.filename = filename;
        this.codec = codec;
        this.pendingAccount = pendingAccount;
    }
    read() {
        return readModelConfig(this.filename);
    }
    list() {
        return this.read().map(redactModel);
    }
    prepare(input, existing) {
        const model = { ...input };
        delete model.originalName;
        delete model.copyFrom;
        // Management response metadata is allocated locally, never imported or
        // accepted from an editor payload as an authoritative native identity.
        delete model.nativeCatalogId;
        delete model.nativeModelId;
        delete model.nativePickerAvailable;
        delete model.nativePickerError;
        delete model.nativeContextWindow;
        delete model.nativeMaxOutputTokens;
        delete model.nativeModelExperiments;
        delete model.configIndex;
        if (!model.name?.startsWith('models/'))
            model.name = `models/${model.name || ''}`;
        if (model.name === 'models/')
            throw new Error('Model name is required');
        const valid = (0, schemaValidator_1.validateCustomModel)(model);
        if (!valid.valid)
            throw new Error(valid.error);
        if (existing &&
            (model.provider !== existing.provider || new URL(model.apiUrl).origin !== new URL(existing.apiUrl).origin)) {
            if ((existing.apiKey && existing.apiKey !== 'none' && (!model.apiKey || isMaskedSecret(model.apiKey))) ||
                Object.values(model.customHeaders || {}).some(isMaskedSecret)) {
                throw new Error('Enter fresh credentials when changing the provider or server address');
            }
        }
        if (isMaskedSecret(model.apiKey) || model.apiKey === undefined) {
            if (isMaskedSecret(model.apiKey) && !existing?.apiKey)
                throw new Error('Enter a key for this new model');
            model.apiKey = existing?.apiKey || '';
            model.encrypted = existing?.encrypted || false;
            if (model.apiKey && !model.encrypted) {
                model.apiKey = this.codec.encryptString(decodeSecret(model.apiKey, this.codec));
                model.encrypted = true;
            }
        }
        else {
            if (/^(enc:|local-gcm:)/.test(model.apiKey || ''))
                throw new Error('Machine-encrypted keys cannot be imported. Enter a fresh key.');
            const plain = decodeSecret(model.apiKey, this.codec);
            model.apiKey = plain ? this.codec.encryptString(plain) : '';
            model.encrypted = !!plain;
        }
        if (model.customHeaders && typeof model.customHeaders === 'object') {
            const old = (existing?.customHeaders || {});
            model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([key, value]) => {
                if (isMaskedSecret(value)) {
                    if (!old[key])
                        throw new Error(`Enter a value for header ${key}`);
                    return [key, existing?.encryptedHeaders ? old[key] : this.codec.encryptString(old[key])];
                }
                return [key, this.codec.encryptString(String(value))];
            }));
            model.encryptedHeaders = true;
        }
        if (Array.isArray(model.googleAccounts)) {
            const previous = Array.isArray(existing?.googleAccounts) ? existing.googleAccounts : [];
            const ids = new Set();
            model.googleAccounts = model.googleAccounts.map((input) => {
                const account = { ...object(input) };
                if (typeof account.id !== 'string' || !account.id)
                    throw new Error('Google account id is required');
                if (ids.has(account.id))
                    throw new Error('Duplicate Google account id');
                ids.add(account.id);
                const stored = previous.find((item) => item.id === account.id);
                const pending = this.pendingAccount?.(account.id);
                const source = stored || pending;
                for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
                    const value = account[field];
                    if (isMaskedSecret(value) || value === undefined) {
                        if (isMaskedSecret(value) && !source?.[field])
                            throw new Error('Account credentials expired or unavailable; sign in or import them again');
                        if (source?.[field])
                            account[field] =
                                stored && existing?.encryptedGoogleAccounts
                                    ? source[field]
                                    : this.codec.encryptString(String(source[field]));
                        else
                            delete account[field];
                    }
                    else if (value) {
                        if (typeof value !== 'string' || /^(enc:|local-gcm:)/.test(value))
                            throw new Error('Enter fresh account credentials instead of a machine-encrypted token');
                        account[field] = this.codec.encryptString(value);
                    }
                }
                return account;
            });
            model.encryptedGoogleAccounts = true;
        }
        return model;
    }
    save(input) {
        const models = this.read();
        const target = input.name?.startsWith('models/') ? input.name : `models/${input.name}`;
        const sourceName = input.originalName || input.copyFrom || target;
        const existing = models.find((model) => model.name === sourceName);
        if ((input.originalName || input.copyFrom) && !existing)
            throw new Error('Original model no longer exists');
        if ((input.originalName || input.copyFrom) && sourceName !== target && models.some((m) => m.name === target)) {
            throw new Error('A model with that name already exists');
        }
        const prepared = this.prepare({ ...input, name: target }, existing);
        const replaceName = input.copyFrom ? target : sourceName;
        const index = models.findIndex((model) => model.name === replaceName);
        if (index < 0)
            models.push(prepared);
        else
            models[index] = prepared;
        if (input.originalName && sourceName !== target) {
            for (const model of models) {
                if (Array.isArray(model.fallbackModels))
                    model.fallbackModels = model.fallbackModels.map((name) => (name === sourceName ? target : name));
            }
        }
        writeJsonAtomic(this.filename, { models });
    }
    delete(name) {
        const models = this.read().filter((model) => model.name !== name);
        for (const model of models) {
            if (Array.isArray(model.fallbackModels))
                model.fallbackModels = model.fallbackModels.filter((item) => item !== name);
        }
        writeJsonAtomic(this.filename, { models });
    }
    import(payload) {
        const incoming = normalizeModelConfig(payload);
        const models = this.read();
        const seen = new Set();
        for (const item of incoming) {
            const name = item.name?.startsWith('models/') ? item.name : `models/${item.name || ''}`;
            if (seen.has(name))
                throw new Error(`Duplicate model in import: ${name}`);
            seen.add(name);
            const index = models.findIndex((m) => m.name === name);
            const prepared = this.prepare({ ...item, name }, models[index]);
            if (index < 0)
                models.push(prepared);
            else
                models[index] = prepared;
        }
        writeJsonAtomic(this.filename, { models });
        return incoming.length;
    }
    export() {
        return {
            version: 1,
            models: this.read().map((entry) => {
                const model = { ...entry };
                delete model.apiKey;
                delete model.encrypted;
                // Headers may contain arbitrary credentials; require re-entry after export.
                delete model.customHeaders;
                delete model.extraHeaders;
                delete model.encryptedHeaders;
                delete model.encryptedGoogleAccounts;
                if (Array.isArray(model.googleAccounts))
                    model.googleAccounts = model.googleAccounts.map((account) => {
                        const redacted = { ...account };
                        for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                            delete redacted[field];
                        return redacted;
                    });
                return model;
            }),
        };
    }
}
exports.ModelStore = ModelStore;
//# sourceMappingURL=modelStore.js.map