"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** Independent sandbox-safe preload; deployment appends this module beside the settings preload. */
const electron_1 = require("electron");
function initContextUsagePreload() {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    const composerSelector = '[data-testid="agent-input-box"], .no-focus-agent-input, ' +
        '[role="combobox"][contenteditable="true"][aria-label="Message input"], ' +
        '[role="combobox"][contenteditable="true"][aria-label="输入消息"], ' +
        '[role="combobox"][contenteditable="true"][aria-label="消息输入"]';
    const triggerSelector = '[data-testid="model-selector-trigger"], button[aria-label*="Select model" i], ' +
        'button[aria-label*="Choose model" i], button[aria-label*="Switch model" i], ' +
        'button[aria-label*="选择模型"], button[aria-label*="切换模型"], ' +
        'button[aria-label*="模型选择器"], button[aria-label*="切换模型选择器"]';
    const states = new Map();
    const toolbarParents = new Set();
    const style = document.createElement('style');
    style.textContent = '[data-agy-context-toolbar]:has(> [data-agy-context-ring]){display:inline-flex!important;align-items:center;gap:2px;max-width:100%}' +
        '[data-agy-context-toolbar]>[data-testid="model-selector-trigger"]{min-width:0;flex:0 1 auto}';
    document.head.append(style);
    const limits = new Map();
    let stopped = false;
    let debounce;
    let customNames = [];
    let namesAt = 0;
    let namesPending = false;
    const visible = (element) => {
        for (let current = element; current; current = current.parentElement) {
            if (current.hidden || current.getAttribute('aria-hidden') === 'true')
                return false;
            const style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    };
    const text = (element) => (element.textContent || '').replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim();
    const idFrom = (value) => typeof value === 'string' && uuid.test(value) ? value : undefined;
    const composers = () => {
        // Native 2.23 also puts .no-focus-agent-input on the model toolbar itself.
        // A composer must contain an editor; a styling class alone is not an editor.
        const editorSelector = 'textarea, [role="combobox"][contenteditable="true"]';
        const candidates = Array.from(document.querySelectorAll(composerSelector))
            .filter((candidate) => visible(candidate) && (candidate.matches(editorSelector) || candidate.querySelector(editorSelector)));
        return candidates
            .filter((candidate) => !candidates.some((other) => other !== candidate && candidate.contains(other)))
            .sort((a, b) => Number(b.matches(editorSelector)) - Number(a.matches(editorSelector)));
    };
    function conversationIdentity(element) {
        for (const attr of ['data-conversation-id', 'data-cascade-id']) {
            const id = idFrom(element.getAttribute(attr));
            if (id)
                return id;
        }
        // Only named conversation properties are identities. Never accept arbitrary React UUIDs,
        // message IDs, tool IDs, storage entries, or the most recently modified conversation.
        try {
            const key = Object.keys(element).find((name) => name.startsWith('__reactFiber') || name.startsWith('__reactInternalInstance'));
            let fiber = key ? element[key] : undefined;
            for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
                const props = fiber.memoizedProps;
                if (!props || typeof props !== 'object')
                    continue;
                for (const value of [
                    props.conversationId, props.cascadeId, props.activeConversationId, props.currentConversationId,
                    props.conversation?.id, props.cascade?.id,
                ]) {
                    const id = idFrom(value);
                    if (id)
                        return id;
                }
            }
        }
        catch {
            /* Unknown React layout: leave identity unavailable. */
        }
        return undefined;
    }
    function readTarget(composer) {
        if (!composer.isConnected || !visible(composer))
            return undefined;
        let scope = composer;
        let trigger = scope.querySelector(triggerSelector);
        // Standalone 2.23 uses a Lexical contenteditable. Its model toolbar is a sibling,
        // so stop at the closest container with one model control instead of searching the page.
        if (composer.matches('[data-lexical-editor], [contenteditable="true"]')) {
            for (let depth = 0; !trigger && depth < 6 && scope.parentElement && scope.parentElement !== document.body; depth++) {
                scope = scope.parentElement;
                const controls = Array.from(scope.querySelectorAll(triggerSelector)).filter(visible);
                if (controls.length > 1)
                    break;
                if (controls.length === 1)
                    trigger = controls[0];
            }
        }
        if (!trigger) {
            trigger = Array.from(scope.querySelectorAll('button, [role="button"]')).find((button) => {
                if (button.hasAttribute('data-agy-context-ring') || !visible(button))
                    return false;
                const name = text(button);
                if (!name || name.length > 120 || /attach|add context|mention|send|submit|附件|添加上下文|提及|发送|提交/i.test(button.getAttribute('aria-label') || ''))
                    return false;
                return customNames.includes(name.toLowerCase()) ||
                    (/\b(gemini|claude|sonnet|opus|haiku|gpt|deepseek|qwen|llama|mistral)\b/i.test(name) &&
                        !!button.querySelector('svg, .codicon-chevron-down'));
            });
        }
        if (!trigger || !visible(trigger))
            return undefined;
        const modelName = text(trigger);
        if (!modelName)
            return undefined;
        let conversationId = conversationIdentity(composer) || conversationIdentity(trigger);
        const panel = composer.closest('[data-testid="conversation-view"], [data-testid="cascade-view"], [data-conversation-id], [data-cascade-id]');
        if (!conversationId && panel)
            conversationId = conversationIdentity(panel);
        // A route identifies only the sole composer; multi-pane/subagent views need their own IDs.
        if (!conversationId && composers().length === 1) {
            const route = `${window.location.pathname} ${window.location.hash}`;
            conversationId = idFrom(route.match(/(?:\/c\/|\/conversation\/)([a-f0-9-]{36})(?:[/?#\s]|$)/i)?.[1]);
        }
        return { trigger, modelName, conversationId, key: `${conversationId || ''}\n${modelName}` };
    }
    function render(state) {
        const { usage, target, ring } = state;
        const limit = usage?.maxTokens;
        const estimated = usage?.source === 'estimated' && typeof usage.currentTokens === 'number' && Number.isFinite(usage.currentTokens);
        const count = estimated ? usage.currentTokens : 0;
        let description = estimated
            ? `Visible transcript estimate: ~${count.toLocaleString('en-US')} tokens`
            : 'Context usage unavailable';
        if (limit)
            description += ` / ${limit.toLocaleString('en-US')} context limit (${usage?.limitSource === 'configured' ? 'configured' : 'public catalog'})`;
        description += '. Hidden prompts, tool definitions and images are not included; actual usage can be higher.';
        if (!target.conversationId)
            description += ' The open conversation could not be identified.';
        if (!limit)
            description += ' Click to look up the model limit in the public catalog.';
        if (ring.title !== description) {
            ring.title = description;
            ring.setAttribute('aria-label', description);
        }
        // This is visibly marked as an estimate; no fabricated measured percentage or safe/unsafe color.
        const fraction = estimated && limit ? Math.max(0, Math.min(1, count / limit)) : 0;
        const svg = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" opacity=".25" stroke-width="2"/><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="44" stroke-dashoffset="${(44 * (1 - fraction)).toFixed(2)}"/><text x="10" y="14" text-anchor="middle" font-size="12" fill="currentColor">${estimated ? '~' : '?'}</text></svg>`;
        if (ring.innerHTML !== svg)
            ring.innerHTML = svg;
        const parent = target.trigger.parentElement;
        if (parent) {
            if (!parent.hasAttribute('data-agy-context-toolbar'))
                parent.setAttribute('data-agy-context-toolbar', '');
            toolbarParents.add(parent);
        }
        if (target.trigger.nextElementSibling !== ring)
            target.trigger.insertAdjacentElement('afterend', ring);
    }
    async function request(state, force = false) {
        if (stopped || states.get(state.composer) !== state)
            return;
        if (state.inFlight) {
            if (force)
                state.queued = true;
            return;
        }
        if (!force && Date.now() - state.lastRequest < 3000)
            return;
        const requested = state.target;
        const discoverLimit = state.discover;
        state.discover = false;
        state.inFlight = true;
        state.lastRequest = Date.now();
        try {
            const usage = await electron_1.ipcRenderer.invoke('storage:get-chat-context-usage', {
                conversationId: requested.conversationId,
                modelName: requested.modelName,
                discoverLimit,
            });
            const current = readTarget(state.composer);
            if (stopped || !current || states.get(state.composer) !== state)
                return;
            if (current.key !== requested.key) {
                state.target = current;
                state.usage = undefined;
                state.lastRequest = 0;
                state.queued = true;
                render(state);
                return;
            }
            if (usage.conversationId && usage.conversationId !== requested.conversationId)
                return;
            state.target = current;
            if (typeof usage.maxTokens === 'number' && Number.isSafeInteger(usage.maxTokens) && usage.maxTokens > 0) {
                if (usage.limitSource === 'public-catalog')
                    limits.set(requested.modelName, { maxTokens: usage.maxTokens, limitSource: usage.limitSource, expires: Date.now() + 300000 });
            }
            else {
                const cached = limits.get(requested.modelName);
                if (cached && Date.now() < cached.expires)
                    Object.assign(usage, { maxTokens: cached.maxTokens, limitSource: cached.limitSource });
            }
            state.usage = usage;
            render(state);
        }
        catch {
            const current = readTarget(state.composer);
            if (states.get(state.composer) === state && current && current.key === requested.key) {
                state.usage = undefined;
                render(state);
            }
        }
        finally {
            state.inFlight = false;
            if (state.queued && !stopped && states.get(state.composer) === state) {
                state.queued = false;
                void request(state, true);
            }
        }
    }
    function refresh(force = false) {
        if (stopped)
            return;
        if (!namesPending && Date.now() - namesAt > 30000) {
            namesAt = Date.now();
            namesPending = true;
            void electron_1.ipcRenderer.invoke('storage:get-custom-models').then((models) => {
                customNames = Array.isArray(models) ? models.flatMap((model) => [model.displayName, model.name])
                    .filter((name) => typeof name === 'string').map((name) => name.toLowerCase()) : [];
                schedule();
            }).catch(() => { }).finally(() => { namesPending = false; });
        }
        // One trigger owns one ring, even if future native DOM changes provide
        // several plausible composer containers for the same model control.
        const targets = new Map();
        const triggers = new Set();
        for (const composer of composers()) {
            const target = readTarget(composer);
            if (target && !triggers.has(target.trigger)) {
                targets.set(composer, target);
                triggers.add(target.trigger);
            }
        }
        for (const [composer, state] of states) {
            if (!targets.has(composer)) {
                state.ring.remove();
                states.delete(composer);
            }
        }
        for (const [composer, target] of targets) {
            let state = states.get(composer);
            let changed = false;
            if (!state) {
                const ring = document.createElement('button');
                ring.type = 'button';
                ring.dataset.agyContextRing = '';
                ring.className = 'agy-context-usage';
                ring.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:none;background:transparent;border:0;color:inherit;opacity:.75;padding:3px;cursor:help;';
                state = { composer, target, ring, inFlight: false, queued: false, discover: false, lastRequest: 0 };
                const ownState = state;
                ring.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ownState.discover = !ownState.usage?.maxTokens;
                    void request(ownState, true);
                });
                ring.addEventListener('mousedown', (event) => event.stopPropagation());
                states.set(composer, state);
                changed = true;
            }
            else if (state.target.key !== target.key) {
                state.usage = undefined;
                state.lastRequest = 0;
                changed = true;
            }
            state.target = target;
            render(state);
            void request(state, force || changed);
        }
    }
    function schedule() {
        if (stopped || debounce)
            return;
        debounce = setTimeout(() => { debounce = undefined; refresh(); }, 100);
    }
    const observer = new MutationObserver((records) => {
        if (records.some((record) => !(record.target instanceof Element && record.target.closest('[data-agy-context-ring]'))))
            schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-hidden', 'data-conversation-id', 'data-cascade-id'] });
    const focus = () => refresh(true);
    const route = () => refresh(true);
    window.addEventListener('focus', focus);
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);
    // Polling also catches transcript appends with no renderer DOM change and missed SPA route events.
    const poll = setInterval(() => refresh(), 5000);
    window.addEventListener('pagehide', () => {
        stopped = true;
        observer.disconnect();
        if (debounce)
            clearTimeout(debounce);
        clearInterval(poll);
        window.removeEventListener('focus', focus);
        window.removeEventListener('popstate', route);
        window.removeEventListener('hashchange', route);
        for (const state of states.values())
            state.ring.remove();
        states.clear();
        for (const parent of toolbarParents)
            parent.removeAttribute('data-agy-context-toolbar');
        toolbarParents.clear();
        style.remove();
    }, { once: true });
    refresh();
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initContextUsagePreload);
    }
    else {
        initContextUsagePreload();
    }
}
//# sourceMappingURL=contextUsagePreload.js.map