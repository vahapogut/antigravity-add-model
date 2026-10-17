/** Transport-independent addon actions shared by Electron IPC and the local IDE manager. */
import type { createModelManager } from './modelManagement';
import { getDiagnostics, clearDiagnostics, getRecentModelNames } from './diagnostics';
import * as path from 'node:path';
import { allocateModelIdentities } from './modelIdentity';
import { nativeCatalogCapabilities, nativeModelExperiments, type CustomModelConfig } from './proxy/modelUtils';
import { getOfficialQuota } from './proxy/shared';
import {
  getChatContextUsage,
  resolveModelContextLimit,
  cleanModelSlug,
  fetchContextLimitFromApi,
  updateCustomModelContextWindow,
} from './chatContext';

export function createModelActions(
  manager: ReturnType<typeof createModelManager>,
): Record<string, (...args: unknown[]) => unknown> {
  return {
    'storage:get-custom-models': () => {
      const models = manager.store.list();
      // The proxy and both management transports share the same persistent
      // native identity registry. Do not regenerate enum IDs in the renderer.
      let identities: ReturnType<typeof allocateModelIdentities> = [];
      let identityError: string | undefined;
      try {
        identities = allocateModelIdentities(path.dirname(manager.store.filename), models);
      } catch (error) {
        // Listing/editing saved providers remains possible when the identity
        // registry is unavailable; native injection must fail closed.
        identityError =
          (error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512) : '') ||
          'Native model identity metadata is unavailable. Retry after resolving the local metadata error.';
      }
      const byName = new Map(identities.map((identity) => [identity.name, identity]));
      const recent = getRecentModelNames();
      const rank = (name: string) => {
        const index = recent.indexOf(name);
        return index < 0 ? recent.length : index;
      };
      return models
        .map((model) => {
          const identity = byName.get(model.name);
          const capabilities = nativeCatalogCapabilities(model as CustomModelConfig);
          return {
            ...model,
            nativeCatalogId: identity?.catalogId,
            nativeModelId: identity?.placeholderId,
            nativePickerAvailable: !!identity?.placeholderId,
            nativeContextWindow: capabilities.maxTokens,
            nativeMaxOutputTokens: capabilities.maxOutputTokens,
            nativeModelExperiments: nativeModelExperiments(model as CustomModelConfig),
            nativePickerError: identity?.placeholderId
              ? undefined
              : identityError ||
                'Native model picker capacity reached; direct API alias remains available. 651 supported slots include native reservations and retained deleted models.',
          };
        })
        .sort((a, b) => rank(a.name) - rank(b.name));
    },
    'storage:save-custom-model': manager.saveModel,
    'storage:delete-custom-model': (name: string) => {
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
    'storage:get-diagnostics': getDiagnostics,
    'storage:clear-diagnostics': clearDiagnostics,
    'storage:get-official-quota': (email?: unknown) => getOfficialQuota(typeof email === 'string' ? email : undefined),
    'storage:get-chat-context-usage': async (payload?: unknown) => {
      let convId: string | undefined;
      let title: string | undefined;
      let modelName: string | undefined;
      let fallbackToLatest = false;

      if (typeof payload === 'string') {
        convId = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as { conversationId?: string; convId?: string; title?: string; modelName?: string; fallbackToLatest?: boolean };
        convId = p.conversationId || p.convId;
        title = p.title;
        modelName = p.modelName;
        fallbackToLatest = p.fallbackToLatest === true;
      }

      const usage = getChatContextUsage(convId, undefined, { title, fallbackToLatest });
      const customModels = manager.store.list();
      let maxTokens = modelName ? resolveModelContextLimit(modelName, customModels) : undefined;

      if (!maxTokens && modelName) {
        try {
          const fetched = await fetchContextLimitFromApi(cleanModelSlug(modelName));
          if (fetched) {
            maxTokens = fetched;
            updateCustomModelContextWindow(modelName, fetched);
          }
        } catch {
        }
      }

      return {
        ...usage,
        maxTokens,
      };
    },
  };
}
