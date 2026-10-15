"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subagentRouting = exports.SubagentRoutingBridge = exports.SubagentRoutingError = void 0;
const crypto_1 = require("crypto");
class SubagentRoutingError extends Error {
    constructor(message, status = 409) {
        super(message);
        this.status = status;
        this.name = 'SubagentRoutingError';
    }
}
exports.SubagentRoutingError = SubagentRoutingError;
const TIERS = new Set(['inherit', 'flash_lite', 'flash', 'pro']);
const MARKER = /\[antigravity-subagent-route:([0-9a-f-]{36})\]/g;
const SNAPSHOT_PROMPT = /("initialPrompt"\s*:\s*)("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")/g;
const DESCRIPTION = 'Model for this subagent: inherit (default), flash_lite, flash, or pro, or the exact saved name of an enabled custom model configured in Antigravity. Display labels and unconfigured model names are not accepted.';
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function identifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
        ? value
        : undefined;
}
function clone(value) {
    return structuredClone(value);
}
function digest(value) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(value)).digest('hex');
}
function tokens(text) {
    return [...text.matchAll(MARKER)].map((match) => match[1]);
}
function stripSnapshotMarkers(text) {
    // Native checkpoint snapshots quote prior prompts as JSON strings. Remove
    // routing markers only from those values before inspecting active markers.
    return text.replace(SNAPSHOT_PROMPT, (_match, prefix, value) => prefix + value.replace(MARKER, ''));
}
function stripMarker(text, token) {
    const marker = `[antigravity-subagent-route:${token}]`;
    return text.split(`\n\n${marker}`).join('').split(marker).join('');
}
function subagents(call) {
    const args = object(call.args);
    if (!args || !Array.isArray(args.Subagents))
        return undefined;
    return args.Subagents.map(object);
}
function callKey(scope, id) {
    return JSON.stringify([scope, id]);
}
/** Parse only structured tool output, never conversation IDs mentioned in arbitrary prose. */
function childIds(value, depth = 0) {
    if (depth > 4)
        return undefined;
    if (typeof value === 'string') {
        try {
            return childIds(JSON.parse(value), depth + 1);
        }
        catch {
            return undefined;
        }
    }
    if (Array.isArray(value)) {
        const ids = value.map((entry) => identifier(object(entry)?.conversationId));
        return ids.length && ids.every(Boolean) ? ids : undefined;
    }
    const record = object(value);
    if (!record)
        return undefined;
    if (identifier(record.conversationId))
        return [record.conversationId];
    if ('output' in record)
        return childIds(record.output, depth + 1);
    for (const key of ['Subagents', 'subagents', 'results']) {
        if (Array.isArray(record[key]))
            return childIds(record[key], depth + 1);
    }
    return undefined;
}
/**
 * Bridge the IDE's fixed subagent tiers at the common Gemini boundary. Provider
 * translators never own this state: history can switch providers at any turn.
 * Opaque, locally issued prompt markers route the very first child request,
 * before its parent receives the spawn tool result.
 */
class SubagentRoutingBridge {
    constructor(options = {}) {
        this.calls = new Map();
        this.markers = new Map();
        this.bindings = new Map();
        /** Bounded scope-only tombstones prevent silent fallback after cache expiry. */
        this.expiredScopes = new Set();
        this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
        this.maxEntries = options.maxEntries ?? 4096;
        this.now = options.now ?? Date.now;
        if (this.ttlMs <= 0 || this.maxEntries < 1)
            throw new Error('Invalid subagent routing cache limits.');
    }
    clear() {
        this.calls.clear();
        this.markers.clear();
        this.bindings.clear();
        this.expiredScopes.clear();
    }
    prune() {
        const time = this.now();
        for (const map of [this.calls, this.markers]) {
            for (const [key, entry] of map)
                if (time - entry.touched >= this.ttlMs)
                    map.delete(key);
            while (map.size > this.maxEntries)
                map.delete(map.keys().next().value);
        }
        for (const [scope, binding] of this.bindings) {
            if (time - binding.touched >= this.ttlMs || !this.markers.has(binding.token)) {
                this.bindings.delete(scope);
                this.expiredScopes.add(scope);
            }
        }
        while (this.bindings.size > this.maxEntries) {
            const scope = this.bindings.keys().next().value;
            this.bindings.delete(scope);
            this.expiredScopes.add(scope);
        }
        while (this.expiredScopes.size > this.maxEntries)
            this.expiredScopes.delete(this.expiredScopes.values().next().value);
    }
    requireMarker(token) {
        const intent = this.markers.get(token);
        if (!intent)
            throw new SubagentRoutingError('Subagent model routing has expired or is unknown. Start a new subagent from its parent.');
        return intent;
    }
    requireModel(name, resolve) {
        const selected = resolve(name);
        if (!selected)
            throw new SubagentRoutingError('The requested subagent model is not an enabled configured custom model.', 400);
        return selected;
    }
    requireBoundModel(name, resolve) {
        if (this.requireModel(name, resolve) !== name)
            throw new SubagentRoutingError('The configured subagent model has changed. Start a new subagent with its current saved name.', 400);
        return name;
    }
    validateBinding(scope, token) {
        const intent = this.requireMarker(token);
        if (scope === intent.scope)
            throw new SubagentRoutingError('A subagent route cannot replace its parent conversation model.');
        if (intent.childScope && intent.childScope !== scope)
            throw new SubagentRoutingError('This subagent route is already assigned to another conversation.');
        const existing = this.bindings.get(scope);
        if (existing && existing.token !== token)
            throw new SubagentRoutingError('Ambiguous subagent model routing for this conversation.');
        return intent;
    }
    bind(scope, token) {
        const intent = this.validateBinding(scope, token);
        intent.childScope = scope;
        intent.touched = this.now();
        this.expiredScopes.delete(scope);
        this.bindings.set(scope, { token, modelName: intent.modelName, touched: this.now() });
    }
    prepareRequest(body, resolve) {
        this.prune();
        const prepared = clone(body);
        const conversation = identifier(object(prepared.labels)?.cascade_id) ?? identifier(prepared.conversationId);
        const context = {
            scope: conversation ? `conversation:${conversation}` : `request:${(0, crypto_1.randomUUID)()}`,
            stable: Boolean(conversation),
            requestId: (0, crypto_1.randomUUID)(),
        };
        const contents = prepared.contents || [];
        const firstUser = contents.findIndex((content) => content.role === 'user' &&
            content.parts?.some((part) => typeof part.text === 'string' && !part.functionResponse && !part.functionCall));
        const routingTokens = new Set();
        for (let index = 0; index < contents.length; index++) {
            const content = contents[index];
            if (content.role !== 'user')
                continue;
            for (const part of content.parts || []) {
                if (typeof part.text !== 'string' || part.functionCall || part.functionResponse)
                    continue;
                part.text = stripSnapshotMarkers(part.text);
                const issued = tokens(part.text);
                for (const token of issued) {
                    this.requireMarker(token);
                    if (index !== firstUser)
                        throw new SubagentRoutingError('A subagent routing marker must belong to the initial child prompt.');
                    routingTokens.add(token);
                    part.text = stripMarker(part.text, token);
                }
            }
        }
        if (routingTokens.size > 1)
            throw new SubagentRoutingError('Multiple subagent model routes were found in one child prompt.');
        let modelName;
        for (const token of routingTokens) {
            const intent = this.requireMarker(token);
            if (intent.scope === context.scope)
                throw new SubagentRoutingError('A subagent route cannot replace its parent conversation model.');
            modelName = this.requireBoundModel(intent.modelName, resolve);
            if (context.stable)
                this.bind(context.scope, token);
            intent.touched = this.now();
        }
        if (!modelName && context.stable) {
            if (this.expiredScopes.has(context.scope))
                throw new SubagentRoutingError('This subagent model route has expired. Start a new subagent from its parent.');
            const binding = this.bindings.get(context.scope);
            if (binding) {
                this.requireMarker(binding.token).touched = this.now();
                modelName = this.requireBoundModel(binding.modelName, resolve);
                binding.touched = this.now();
            }
        }
        this.restoreHistory(prepared, context);
        this.relaxTools(prepared);
        this.prune();
        context.modelName = modelName;
        return { body: prepared, context, modelName };
    }
    relaxTools(body) {
        if (!Array.isArray(body.tools))
            return;
        for (const group of body.tools) {
            const declarations = object(group)?.functionDeclarations;
            if (!Array.isArray(declarations))
                continue;
            for (const value of declarations) {
                const declaration = object(value);
                if (declaration?.name !== 'invoke_subagent')
                    continue;
                for (const key of ['parameters', 'parametersJsonSchema']) {
                    const parameters = object(clone(declaration[key]));
                    const array = object(object(parameters?.properties)?.Subagents);
                    const properties = object(object(array?.items)?.properties);
                    const model = object(properties?.Model);
                    if (!model)
                        continue;
                    delete model.enum;
                    model.description = DESCRIPTION;
                    declaration[key] = parameters;
                }
            }
        }
    }
    restoreHistory(body, context) {
        const pending = new Map();
        for (const content of body.contents || []) {
            for (const part of content.parts || []) {
                const call = object(part.functionCall);
                if (call?.name === 'invoke_subagent') {
                    const entries = subagents(call);
                    if (!entries)
                        continue;
                    const markerStates = [];
                    const entryMarkers = new Map();
                    let expired = false;
                    for (let index = 0; index < entries.length; index++) {
                        const entry = entries[index];
                        if (!entry || typeof entry.Prompt !== 'string')
                            continue;
                        const entryTokens = tokens(entry.Prompt);
                        if (entryTokens.length > 1)
                            throw new SubagentRoutingError('Ambiguous subagent routing in conversation history.');
                        for (const token of entryTokens) {
                            entry.Prompt = stripMarker(entry.Prompt, token);
                            const state = this.markers.get(token);
                            // Restarted/expired history must not lock the parent out of
                            // starting a fresh child. Only current child ingress fails closed.
                            if (!state) {
                                expired = true;
                                continue;
                            }
                            if (context.stable && state.scope !== context.scope)
                                throw new SubagentRoutingError('Subagent tool history belongs to another parent conversation.');
                            markerStates.push(state);
                            entryMarkers.set(index, token);
                            if (state.selector === undefined)
                                delete entry.Model;
                            else
                                entry.Model = state.selector;
                            state.touched = this.now();
                        }
                    }
                    const ids = new Set(markerStates.map((state) => callKey(state.scope, state.toolId)));
                    if (ids.size > 1)
                        throw new SubagentRoutingError('Subagent tool history contains unrelated spawn markers.');
                    const id = identifier(call.id);
                    const key = ids.size ? [...ids][0] : id ? callKey(context.scope, id) : undefined;
                    const saved = key ? this.calls.get(key) : undefined;
                    if (expired || !saved || saved.intents.length !== entries.length)
                        continue;
                    // With no marker, only an exact copy of the emitted arguments may
                    // use the scoped ID. Reused builtin IDs must not inherit old intent.
                    if (!markerStates.length &&
                        digest(call.args) !== saved.clientDigest &&
                        digest(call.args) !== saved.originalDigest)
                        continue;
                    if (saved.intents.some((intent) => intent.token && !this.markers.has(intent.token)))
                        continue;
                    for (const [index, token] of entryMarkers) {
                        if (saved.intents[index]?.token !== token)
                            throw new SubagentRoutingError('Subagent tool history changed the order of its spawn markers.');
                    }
                    if (!id)
                        call.id = saved.toolId;
                    const wireId = identifier(call.id);
                    if (wireId)
                        pending.set(wireId, saved);
                    for (let index = 0; index < entries.length; index++) {
                        const entry = entries[index];
                        const intent = saved.intents[index];
                        if (!entry || !intent.token)
                            continue;
                        const state = this.requireMarker(intent.token);
                        if (intent.selector === undefined)
                            delete entry.Model;
                        else
                            entry.Model = intent.selector;
                        if (typeof entry.Prompt === 'string')
                            entry.Prompt = stripMarker(entry.Prompt, intent.token);
                        state.touched = this.now();
                    }
                    saved.touched = this.now();
                }
                const response = object(part.functionResponse);
                if (response?.name !== 'invoke_subagent')
                    continue;
                const id = identifier(response.id);
                const pair = id ? pending.get(id) : pending.size === 1 ? [...pending.values()][0] : undefined;
                if (!pair)
                    continue;
                if (!id)
                    response.id = [...pending.entries()].find(([, value]) => value === pair)?.[0];
                for (const [key, value] of pending)
                    if (value === pair)
                        pending.delete(key);
                const ids = childIds(response.response);
                if (!ids || ids.length !== pair.intents.length || new Set(ids).size !== ids.length)
                    continue;
                // Validate the entire result before binding; partial results cannot
                // shift one requested model onto a different child.
                const targets = pair.intents.map((intent, index) => ({ intent, scope: `conversation:${ids[index]}` }));
                for (const { intent, scope } of targets)
                    if (intent.token)
                        this.validateBinding(scope, intent.token);
                for (const { intent, scope } of targets)
                    if (intent.token)
                        this.bind(scope, intent.token);
            }
        }
    }
    rewriteCandidate(candidate, context, resolve) {
        this.prune();
        const rewritten = clone(candidate);
        const content = object(object(rewritten)?.content);
        if (!Array.isArray(content?.parts))
            return rewritten;
        for (const part of content.parts) {
            const call = object(object(part)?.functionCall);
            if (call?.name !== 'invoke_subagent')
                continue;
            this.rewriteCall(call, context, resolve);
        }
        this.prune();
        return rewritten;
    }
    rewriteResponse(response, context, resolve) {
        const rewritten = clone(response);
        const record = object(rewritten);
        if (Array.isArray(record?.candidates))
            record.candidates = record.candidates.map((candidate) => this.rewriteCandidate(candidate, context, resolve));
        return rewritten;
    }
    rewriteCall(call, context, resolve) {
        const entries = subagents(call);
        if (!entries)
            return;
        const intents = entries.map((entry) => {
            if (!entry)
                return {};
            if (entry.Model !== undefined && typeof entry.Model !== 'string')
                throw new SubagentRoutingError('A subagent Model must be a built-in tier or an exact configured model name.', 400);
            const selector = typeof entry?.Model === 'string' ? entry.Model.trim() : '';
            const inherited = (!selector || selector === 'inherit') && context.modelName;
            if (!inherited && (!selector || TIERS.has(selector)))
                return {};
            if (typeof entry.Prompt !== 'string')
                throw new SubagentRoutingError('Custom-model subagents require a text Prompt for safe routing.', 400);
            return {
                selector: entry.Model,
                modelName: inherited ? this.requireBoundModel(inherited, resolve) : this.requireModel(selector, resolve),
            };
        });
        if (intents.filter((intent) => intent.modelName).length > Math.min(128, this.maxEntries))
            throw new SubagentRoutingError('Too many custom-model subagents were requested in one tool call.', 400);
        const originalDigest = digest(call.args);
        let id = identifier(call.id) ?? `subagent_${(0, crypto_1.randomUUID)().split('-').join('')}`;
        const previous = this.calls.get(callKey(context.scope, id));
        // Providers sometimes repeat the same completed call in a final chunk.
        if (previous?.requestId === context.requestId && previous.originalDigest === originalDigest) {
            for (let index = 0; index < entries.length; index++) {
                const intent = previous.intents[index];
                if (!intent.token)
                    continue;
                const state = this.requireMarker(intent.token);
                this.requireBoundModel(state.modelName, resolve);
                entries[index].Model = 'inherit';
                entries[index].Prompt += `\n\n[antigravity-subagent-route:${intent.token}]`;
            }
            call.id = previous.toolId;
            return;
        }
        if (previous)
            id = `subagent_${(0, crypto_1.randomUUID)().split('-').join('')}`;
        call.id = id;
        for (let index = 0; index < entries.length; index++) {
            const intent = intents[index];
            if (!intent.modelName)
                continue;
            const token = (0, crypto_1.randomUUID)();
            intent.token = token;
            this.markers.set(token, {
                scope: context.scope,
                toolId: id,
                selector: intent.selector,
                modelName: intent.modelName,
                touched: this.now(),
            });
            entries[index].Model = 'inherit';
            entries[index].Prompt += `\n\n[antigravity-subagent-route:${token}]`;
        }
        this.calls.set(callKey(context.scope, id), {
            scope: context.scope,
            toolId: id,
            requestId: context.requestId,
            intents,
            originalDigest,
            clientDigest: digest(call.args),
            touched: this.now(),
        });
    }
}
exports.SubagentRoutingBridge = SubagentRoutingBridge;
exports.subagentRouting = new SubagentRoutingBridge();
//# sourceMappingURL=subagentRouting.js.map