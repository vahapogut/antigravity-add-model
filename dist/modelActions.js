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
exports.createModelActions = createModelActions;
const diagnostics_1 = require("./diagnostics");
const path = __importStar(require("node:path"));
const modelIdentity_1 = require("./modelIdentity");
const modelUtils_1 = require("./proxy/modelUtils");
const shared_1 = require("./proxy/shared");
const chatContext_1 = require("./chatContext");
function createModelActions(manager) {
    return {
        'storage:get-custom-models': () => {
            const models = manager.store.list();
            // The proxy and both management transports share the same persistent
            // native identity registry. Do not regenerate enum IDs in the renderer.
            let identities = [];
            let identityError;
            try {
                identities = (0, modelIdentity_1.allocateModelIdentities)(path.dirname(manager.store.filename), models);
            }
            catch (error) {
                // Listing/editing saved providers remains possible when the identity
                // registry is unavailable; native injection must fail closed.
                identityError =
                    (error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512) : '') ||
                        'Native model identity metadata is unavailable. Retry after resolving the local metadata error.';
            }
            const byName = new Map(identities.map((identity) => [identity.name, identity]));
            const recent = (0, diagnostics_1.getRecentModelNames)();
            const rank = (name) => {
                const index = recent.indexOf(name);
                return index < 0 ? recent.length : index;
            };
            return models
                .map((model) => {
                const identity = byName.get(model.name);
                const capabilities = (0, modelUtils_1.nativeCatalogCapabilities)(model);
                return {
                    ...model,
                    nativeCatalogId: identity?.catalogId,
                    nativeModelId: identity?.placeholderId,
                    nativePickerAvailable: !!identity?.placeholderId,
                    nativeContextWindow: capabilities.maxTokens,
                    nativeMaxOutputTokens: capabilities.maxOutputTokens,
                    nativeModelExperiments: (0, modelUtils_1.nativeModelExperiments)(model),
                    nativePickerError: identity?.placeholderId
                        ? undefined
                        : identityError ||
                            'Native model picker capacity reached; direct API alias remains available. 651 supported slots include native reservations and retained deleted models.',
                };
            })
                .sort((a, b) => rank(a.name) - rank(b.name));
        },
        'storage:save-custom-model': manager.saveModel,
        'storage:delete-custom-model': (name) => {
            manager.store.delete(name);
            return { success: true };
        },
        'storage:test-model-connection': manager.testModel,
        'storage:test-model-generation': manager.testGeneration,
        'storage:create-effort-variants': manager.createEffortVariants,
        'storage:get-provider-presets': manager.presets,
        'storage:discover-models': manager.discoverModels,
        'storage:discover-local': manager.discoverLocal,
        'storage:export-custom-models': () => manager.store.export(),
        'storage:import-custom-models': (payload) => ({ success: true, count: manager.store.import(payload) }),
        'storage:get-gateway': manager.getGateway,
        'storage:save-gateway': manager.saveGateway,
        'storage:test-gateway': manager.testGateway,
        'storage:import-gateway-models': manager.importGatewayModels,
        'storage:open-gateway-dashboard': manager.openDashboard,
        'storage:google-login': manager.googleLogin,
        'storage:google-login-cancel': manager.googleLoginCancel,
        'storage:google-test-account': manager.googleTestAccount,
        'storage:google-account-prepare': manager.googlePrepareAccount,
        'storage:google-pool-status': manager.googlePoolStatus,
        'storage:google-link-account': manager.googleLinkAccount,
        'storage:google-select-account': manager.googleSelectAccount,
        'storage:google-remove-account': manager.googleRemoveAccount,
        'storage:get-diagnostics': diagnostics_1.getDiagnostics,
        'storage:clear-diagnostics': diagnostics_1.clearDiagnostics,
        'storage:get-official-quota': (email) => (0, shared_1.getOfficialQuota)(typeof email === 'string' ? email : undefined),
        'storage:get-chat-context-usage': async (payload) => {
            let convId;
            let title;
            let modelName;
            let fallbackToLatest = false;
            if (typeof payload === 'string') {
                convId = payload;
            }
            else if (payload && typeof payload === 'object') {
                const p = payload;
                convId = p.conversationId || p.convId;
                title = p.title;
                modelName = p.modelName;
                fallbackToLatest = p.fallbackToLatest === true;
            }
            const usage = (0, chatContext_1.getChatContextUsage)(convId, undefined, { title, fallbackToLatest });
            const customModels = manager.store.list();
            let maxTokens = modelName ? (0, chatContext_1.resolveModelContextLimit)(modelName, customModels) : undefined;
            if (!maxTokens && modelName) {
                try {
                    const fetched = await (0, chatContext_1.fetchContextLimitFromApi)((0, chatContext_1.cleanModelSlug)(modelName));
                    if (fetched) {
                        maxTokens = fetched;
                        (0, chatContext_1.updateCustomModelContextWindow)(modelName, fetched);
                    }
                }
                catch {
                }
            }
            return {
                ...usage,
                maxTokens,
            };
        },
    };
}
//# sourceMappingURL=modelActions.js.map