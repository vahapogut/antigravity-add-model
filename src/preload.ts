/**
 * Preload script — runs in every BrowserWindow before the page loads.
 * Exposes a minimal, secure API via contextBridge so the renderer can
 * communicate with the main-process auto-updater without nodeIntegration.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

// ─── Type Declarations for APIs exposed to renderer ──────────────────────────

interface UpdaterState {
  type: string;
  update?: { version: string };
}

type UnsubscribeFn = () => void;

interface UpdaterAPI {
  onStateChanged: (callback: (state: UpdaterState) => void) => UnsubscribeFn;
  applyUpdate: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
}

interface DialogAPI {
  showOpenDialog: () => Promise<string | undefined>;
}

interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  payload?: unknown;
}

interface NotificationAPI {
  send: (options: NotificationOptions) => Promise<void>;
  openSystemPreferences: () => Promise<void>;
  onClicked: (callback: (payload: unknown) => void) => UnsubscribeFn;
}

interface StorageAPI {
  getItems: () => Promise<Record<string, string | null>>;
  updateItems: (changes: Record<string, string | null>) => Promise<void>;
  onChanged: (callback: (changes: Record<string, string | null>) => void) => UnsubscribeFn;
  getCustomModels: () => Promise<CustomModelEntry[]>;
  saveCustomModel: (model: CustomModelEntry) => Promise<{ success: boolean; error?: string }>;
  deleteCustomModel: (modelName: string) => Promise<{ success: boolean; error?: string }>;
  testModelConnection: (model: TestModelParams) => Promise<ConnectionTestResult>;
}

interface LogsAPI {
  getElectronLogs: () => Promise<string>;
}

interface ExtensionsAPI {
  sendAuthorities: (authoritiesMap: Record<string, string>) => Promise<void>;
}

interface DeepLinkAPI {
  onDeepLink: (callback: (url: string) => void) => UnsubscribeFn;
  getStoredDeepLink: () => Promise<string | undefined>;
}

interface AgentAPI {
  updateActiveAgentCount: (count: number) => Promise<void>;
}

interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
}

interface ElectronNativeAPI {
  getZoomLevel: () => number;
  setTitleBarOverlay: (options: TitleBarOverlayOptions) => Promise<void>;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  unmaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
  toggleDevTools: () => Promise<void>;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  openExternal: (url: string) => Promise<void>;
}

interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  [key: string]: unknown;
}

interface TestModelParams {
  apiUrl: string;
  provider: string;
  apiKey?: string;
  allowUnauthorized?: boolean;
}

interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message?: string;
  error?: string;
}

// ─── API Definitions ─────────────────────────────────────────────────────────

const updaterAPI: UpdaterAPI = {
  onStateChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdaterState) => {
      callback(state);
    };
    ipcRenderer.on('updater:state-changed', handler);
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('updater:state-changed', handler);
    };
  },
  applyUpdate: () => ipcRenderer.invoke('updater:apply'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
};

const dialogAPI: DialogAPI = {
  showOpenDialog: () => ipcRenderer.invoke('dialog:open-workspace'),
};

const notificationAPI: NotificationAPI = {
  send: (options) => ipcRenderer.invoke('notification:send', options),
  openSystemPreferences: () => ipcRenderer.invoke('notification:open-system-preferences'),
  onClicked: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload);
    };
    ipcRenderer.on('notification:clicked', handler);
    return () => {
      ipcRenderer.removeListener('notification:clicked', handler);
    };
  },
};

const storageAPI: StorageAPI = {
  getItems: () => ipcRenderer.invoke('storage:get-items'),
  updateItems: (changes) => ipcRenderer.invoke('storage:update-items', changes),
  onChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, changes: Record<string, string | null>) => {
      callback(changes);
    };
    ipcRenderer.on('storage:changed', handler);
    return () => {
      ipcRenderer.removeListener('storage:changed', handler);
    };
  },
  getCustomModels: () => ipcRenderer.invoke('storage:get-custom-models'),
  saveCustomModel: (model) => ipcRenderer.invoke('storage:save-custom-model', model),
  deleteCustomModel: (modelName) => ipcRenderer.invoke('storage:delete-custom-model', modelName),
  testModelConnection: (model) => ipcRenderer.invoke('storage:test-model-connection', model),
};

const logsAPI: LogsAPI = {
  getElectronLogs: () => ipcRenderer.invoke('logs:electron'),
};

const extensionsAPI: ExtensionsAPI = {
  sendAuthorities: (authoritiesMap) => ipcRenderer.invoke('extensions:send-authorities', authoritiesMap),
};

const deepLinkAPI: DeepLinkAPI = {
  onDeepLink: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => {
      callback(url);
    };
    ipcRenderer.on('deep-link', handler);
    return () => {
      ipcRenderer.removeListener('deep-link', handler);
    };
  },
  getStoredDeepLink: () => ipcRenderer.invoke('deep-link:get-stored'),
};

const agentAPI: AgentAPI = {
  updateActiveAgentCount: (count) => ipcRenderer.invoke('agent:update-active-count', count),
};

const electronNativeAPI: ElectronNativeAPI = {
  getZoomLevel: () => webFrame.getZoomFactor(),
  setTitleBarOverlay: (options) => ipcRenderer.invoke('window:set-title-bar-overlay', options),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  close: () => ipcRenderer.invoke('window:close'),
  toggleDevTools: () => ipcRenderer.invoke('window:toggle-devtools'),
  zoomIn: () => {
    const current = webFrame.getZoomLevel();
    webFrame.setZoomLevel(current + 0.5);
  },
  zoomOut: () => {
    const current = webFrame.getZoomLevel();
    webFrame.setZoomLevel(current - 0.5);
  },
  resetZoom: () => {
    webFrame.setZoomLevel(0);
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
};

// ─── Expose all APIs via contextBridge ──────────────────────────────────────

contextBridge.exposeInMainWorld('electronUpdater', updaterAPI);
contextBridge.exposeInMainWorld('dialog', dialogAPI);
contextBridge.exposeInMainWorld('nativeNotifications', notificationAPI);
contextBridge.exposeInMainWorld('nativeStorage', storageAPI);
contextBridge.exposeInMainWorld('logs', logsAPI);
contextBridge.exposeInMainWorld('extensions', extensionsAPI);
contextBridge.exposeInMainWorld('deepLink', deepLinkAPI);
contextBridge.exposeInMainWorld('agent', agentAPI);
contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);

// ─── Renderer Augmentations (for TypeScript global type declarations) ──────

declare global {
  interface Window {
    electronUpdater: UpdaterAPI;
    dialog: DialogAPI;
    nativeNotifications: NotificationAPI;
    nativeStorage: StorageAPI;
    logs: LogsAPI;
    extensions: ExtensionsAPI;
    deepLink: DeepLinkAPI;
    agent: AgentAPI;
    electronNative: ElectronNativeAPI;
  }
}

// ─── Custom Models UI Injection ─────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  function findRefreshButton(): HTMLButtonElement | null {
    const buttons = Array.from(document.querySelectorAll('button'));
    return (buttons.find((b) => b.textContent?.trim() === 'Refresh') as HTMLButtonElement) || null;
  }

  interface McpLayout {
    mainContainer: Node;
    headerRow: Element;
    contentBlock: Element | null;
  }

  function findMcpSectionContainer(): McpLayout | null {
    const refreshBtn = findRefreshButton();
    if (!refreshBtn) return null;

    const btnGroup = refreshBtn.parentNode;
    if (!btnGroup) return null;

    const headerRow = btnGroup.parentNode as Element;
    if (!headerRow) return null;

    const mainContainer = headerRow.parentNode;
    if (!mainContainer) return null;

    const contentBlock = headerRow.nextElementSibling;

    return {
      mainContainer,
      headerRow,
      contentBlock,
    };
  }

  // ─── Provider Icons & Status Helpers ──────────────────────────────
  const PROVIDER_ICONS: Record<string, string> = {
    openai: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 17l10 5 10-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    anthropic: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="4" height="8" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="5" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="17" y="2" width="4" height="20" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`,
    google: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M12 4a8 8 0 0 1 5.66 13.66L12 12V4z" fill="currentColor" fill-opacity="0.2"/></svg>`,
    ollama: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/><path d="M8 15c1 1.5 3 2 4 2s3-.5 4-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    openrouter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity="0.3"/></svg>`,
    custom: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };

  const PROVIDER_COLORS: Record<string, string> = {
    openai: '#10a37f',
    anthropic: '#d97757',
    google: '#4285f4',
    ollama: '#f0f0f0',
    openrouter: '#ff7a45',
    custom: '#a855f7',
  };

  function getProviderIcon(provider: string): string {
    return PROVIDER_ICONS[provider] || PROVIDER_ICONS.custom;
  }

  function getProviderColor(provider: string): string {
    return PROVIDER_COLORS[provider] || PROVIDER_COLORS.custom;
  }

  async function renderCustomModelsList(): Promise<void> {
    const contentArea = document.getElementById('agy-custom-models-content');
    if (!contentArea) return;

    contentArea.innerHTML = '';

    try {
      const models = await storageAPI.getCustomModels();
      if (!models || models.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.style.display = 'flex';
        placeholder.style.flexDirection = 'column';
        placeholder.style.alignItems = 'center';
        placeholder.style.justifyContent = 'center';
        placeholder.style.padding = '24px';
        placeholder.style.backgroundColor = '#18181b';
        placeholder.style.border = '1px solid #27272a';
        placeholder.style.borderRadius = '8px';
        placeholder.style.textAlign = 'center';

        placeholder.innerHTML = `
                    <div style="font-size: 15px; font-weight: 600; color: #f4f4f5; margin-bottom: 4px;">No Custom Models</div>
                    <div style="font-size: 13px; color: #a1a1aa;">You currently don't have any custom models installed. Add a custom model above.</div>
                `;
        contentArea.appendChild(placeholder);
      } else {
        models.forEach((model) => {
          const item = document.createElement('div');
          item.style.display = 'flex';
          item.style.justifyContent = 'space-between';
          item.style.alignItems = 'center';
          item.style.padding = '12px 16px';
          item.style.backgroundColor = '#18181b';
          item.style.border = '1px solid #27272a';
          item.style.borderRadius = '8px';
          item.style.transition = 'border-color 0.15s ease, background-color 0.15s ease';
          item.style.marginBottom = '8px';

          item.addEventListener('mouseenter', () => {
            item.style.borderColor = '#3f3f46';
            item.style.backgroundColor = '#1c1c1f';
          });
          item.addEventListener('mouseleave', () => {
            item.style.borderColor = '#27272a';
            item.style.backgroundColor = '#18181b';
          });

          // ─── Left: Provider icon + model info ────────────
          const left = document.createElement('div');
          left.style.display = 'flex';
          left.style.alignItems = 'center';
          left.style.gap = '12px';

          // Provider icon bubble
          const iconWrapper = document.createElement('div');
          iconWrapper.style.width = '32px';
          iconWrapper.style.height = '32px';
          iconWrapper.style.borderRadius = '8px';
          iconWrapper.style.display = 'flex';
          iconWrapper.style.alignItems = 'center';
          iconWrapper.style.justifyContent = 'center';
          iconWrapper.style.backgroundColor = getProviderColor(model.provider as string) + '18';
          iconWrapper.style.color = getProviderColor(model.provider as string);
          iconWrapper.style.flexShrink = '0';
          iconWrapper.innerHTML = getProviderIcon(model.provider as string);

          // Text info
          const info = document.createElement('div');
          info.style.display = 'flex';
          info.style.flexDirection = 'column';
          info.style.gap = '2px';

          // Title row with status dot
          const titleRow = document.createElement('div');
          titleRow.style.display = 'flex';
          titleRow.style.alignItems = 'center';
          titleRow.style.gap = '6px';

          // Status indicator dot
          const statusDot = document.createElement('span');
          statusDot.style.width = '6px';
          statusDot.style.height = '6px';
          statusDot.style.borderRadius = '50%';
          statusDot.style.flexShrink = '0';
          statusDot.style.backgroundColor = '#71717a'; // neutral = unknown
          statusDot.title = 'Connection status unknown (test to verify)';
          statusDot.style.transition = 'background-color 0.3s ease';

          const title = document.createElement('div');
          title.style.fontSize = '14px';
          title.style.fontWeight = '500';
          title.style.color = '#f4f4f5';
          title.textContent = (model.displayName as string) || (model.name as string);

          titleRow.appendChild(statusDot);
          titleRow.appendChild(title);

          // Subtitle with provider badge
          const sub = document.createElement('div');
          sub.style.fontSize = '12px';
          sub.style.color = '#a1a1aa';
          sub.style.display = 'flex';
          sub.style.alignItems = 'center';
          sub.style.gap = '8px';

          // Provider badge
          const badge = document.createElement('span');
          badge.style.fontSize = '10px';
          badge.style.fontWeight = '600';
          badge.style.textTransform = 'uppercase';
          badge.style.letterSpacing = '0.5px';
          badge.style.padding = '2px 6px';
          badge.style.borderRadius = '4px';
          badge.style.backgroundColor = getProviderColor(model.provider as string) + '22';
          badge.style.color = getProviderColor(model.provider as string);
          badge.textContent = model.provider as string;

          sub.appendChild(badge);
          sub.appendChild(document.createTextNode(model.apiUrl as string));

          info.appendChild(titleRow);
          info.appendChild(sub);

          left.appendChild(iconWrapper);
          left.appendChild(info);

          // ─── Right: Action buttons ──────────────────
          const actions = document.createElement('div');
          actions.style.display = 'flex';
          actions.style.gap = '4px';
          actions.style.alignItems = 'center';

          // Test Connection button
          const testBtn = document.createElement('button');
          testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
          testBtn.style.background = 'transparent';
          testBtn.style.border = 'none';
          testBtn.style.color = '#a1a1aa';
          testBtn.style.cursor = 'pointer';
          testBtn.style.padding = '6px';
          testBtn.style.borderRadius = '4px';
          testBtn.style.display = 'flex';
          testBtn.style.alignItems = 'center';
          testBtn.style.justifyContent = 'center';
          testBtn.style.transition = 'color 0.15s ease, background-color 0.15s ease';
          testBtn.title = 'Test connection';

          testBtn.addEventListener('mouseenter', () => {
            testBtn.style.color = '#22c55e';
            testBtn.style.backgroundColor = 'rgba(34, 197, 94, 0.1)';
          });
          testBtn.addEventListener('mouseleave', () => {
            testBtn.style.color = '#a1a1aa';
            testBtn.style.backgroundColor = 'transparent';
          });

          testBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Show loading spinner
            const originalHtml = testBtn.innerHTML;
            testBtn.style.color = '#fbbf24';
            testBtn.style.cursor = 'wait';
            testBtn.disabled = true;
            testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;

            try {
              const result = await storageAPI.testModelConnection({
                apiUrl: model.apiUrl as string,
                provider: model.provider as string,
                apiKey: model.apiKey as string,
                allowUnauthorized: model.allowUnauthorized as boolean | undefined,
              });

              if (result.success) {
                statusDot.style.backgroundColor = '#22c55e'; // green
                statusDot.title = result.message || 'Connected';
                testBtn.title = 'Connected ✓';
                testBtn.style.color = '#22c55e';
                testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
              } else {
                statusDot.style.backgroundColor = '#ef4444'; // red
                const errMsg = result.error || 'Connection failed';
                statusDot.title = errMsg;
                testBtn.title = errMsg;
                testBtn.style.color = '#ef4444';
                testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
              }
            } catch (err) {
              statusDot.style.backgroundColor = '#ef4444';
              statusDot.title = 'Connection test failed';
              testBtn.title = 'Connection test failed';
              testBtn.style.color = '#ef4444';
              testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
            }

            testBtn.style.cursor = 'pointer';

            // Reset to neutral after 3 seconds
            setTimeout(() => {
              testBtn.disabled = false;
              testBtn.style.cursor = 'pointer';
              testBtn.style.color = '#a1a1aa';
              testBtn.style.borderColor = '#3f3f46';
              testBtn.innerHTML = originalHtml;
            }, 3000);
          });

          // Delete button
          const deleteBtn = document.createElement('button');
          deleteBtn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                    `;
          deleteBtn.style.background = 'transparent';
          deleteBtn.style.border = 'none';
          deleteBtn.style.color = '#a1a1aa';
          deleteBtn.style.cursor = 'pointer';
          deleteBtn.style.padding = '6px';
          deleteBtn.style.borderRadius = '4px';
          deleteBtn.style.display = 'flex';
          deleteBtn.style.alignItems = 'center';
          deleteBtn.style.justifyContent = 'center';
          deleteBtn.style.transition = 'color 0.15s ease, background-color 0.15s ease';

          deleteBtn.addEventListener('mouseenter', () => {
            deleteBtn.style.color = '#ef4444';
            deleteBtn.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
          });
          deleteBtn.addEventListener('mouseleave', () => {
            deleteBtn.style.color = '#a1a1aa';
            deleteBtn.style.backgroundColor = 'transparent';
          });

          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete the model "${model.displayName || model.name}"?`)) {
              await storageAPI.deleteCustomModel(model.name as string);
              await renderCustomModelsList();

              const refreshBtn = findRefreshButton();
              if (refreshBtn) refreshBtn.click();
            }
          });

          actions.appendChild(testBtn);
          actions.appendChild(deleteBtn);

          item.appendChild(left);
          item.appendChild(actions);
          contentArea.appendChild(item);
        });
      }
    } catch (err) {
      console.error('Failed to load custom models in list:', err);
    }
  }

  async function injectCustomModelsSection(): Promise<void> {
    const layout = findMcpSectionContainer();
    if (!layout) return;

    const { mainContainer, headerRow, contentBlock } = layout;

    if (document.getElementById('agy-custom-models-section')) return;

    const section = document.createElement('div');
    section.id = 'agy-custom-models-section';
    section.style.marginTop = '24px';
    section.style.display = 'flex';
    section.style.flexDirection = 'column';
    section.style.gap = '12px';

    const newHeaderRow = document.createElement('div');
    newHeaderRow.className = (headerRow as HTMLElement).className;
    newHeaderRow.style.cssText = (headerRow as HTMLElement).style.cssText;
    newHeaderRow.style.display = 'flex';
    newHeaderRow.style.justifyContent = 'space-between';
    newHeaderRow.style.alignItems = 'center';
    newHeaderRow.style.marginBottom = '8px';

    const originalHeading = headerRow.firstElementChild as HTMLElement;
    const newHeading = document.createElement(originalHeading ? originalHeading.tagName : 'div');
    if (originalHeading) {
      newHeading.className = originalHeading.className;
      newHeading.style.cssText = originalHeading.style.cssText;
    }
    newHeading.textContent = 'Custom Models';

    const newBtnGroup = document.createElement('div');
    const originalBtnGroup = headerRow.lastElementChild as HTMLElement;
    if (originalBtnGroup) {
      newBtnGroup.className = originalBtnGroup.className;
      newBtnGroup.style.cssText = originalBtnGroup.style.cssText;
    }
    newBtnGroup.style.display = 'flex';
    newBtnGroup.style.gap = '8px';
    newBtnGroup.style.alignItems = 'center';

    const addModelBtn = document.createElement('button');
    addModelBtn.id = 'agy-add-model-btn';
    addModelBtn.textContent = 'Add Model';
    const refreshBtn = findRefreshButton();
    if (refreshBtn) {
      addModelBtn.className = refreshBtn.className;
      addModelBtn.style.cssText = refreshBtn.style.cssText;
    }
    addModelBtn.style.cursor = 'pointer';
    addModelBtn.addEventListener('click', () => {
      openAddModelModal();
    });

    newBtnGroup.appendChild(addModelBtn);
    newHeaderRow.appendChild(newHeading);
    newHeaderRow.appendChild(newBtnGroup);

    const contentArea = document.createElement('div');
    contentArea.id = 'agy-custom-models-content';
    contentArea.style.display = 'flex';
    contentArea.style.flexDirection = 'column';
    contentArea.style.gap = '8px';

    section.appendChild(newHeaderRow);
    section.appendChild(contentArea);

    if (contentBlock && contentBlock.nextSibling) {
      mainContainer.insertBefore(section, contentBlock.nextSibling);
    } else {
      mainContainer.appendChild(section);
    }

    await renderCustomModelsList();
  }

  function openAddModelModal(): void {
    // Remove existing modal if any
    const existing = document.getElementById('agy-modal-overlay');
    if (existing) existing.remove();

    // Modal overlay backdrop
    const overlay = document.createElement('div');
    overlay.id = 'agy-modal-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.zIndex = '999999';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.2s ease-in-out';

    // Modal card container
    const modal = document.createElement('div');
    modal.id = 'agy-modal-card';
    modal.style.width = '520px';
    modal.style.maxHeight = '90vh';
    modal.style.overflowY = 'auto';
    modal.style.backgroundColor = '#18181b';
    modal.style.border = '1px solid #27272a';
    modal.style.borderRadius = '16px';
    modal.style.padding = '32px';
    modal.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5)';
    modal.style.color = '#f4f4f5';
    modal.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    modal.style.transform = 'scale(0.9) translateY(20px)';
    modal.style.transition = 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';

    modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div id="agy-modal-provider-icon" style="width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; background-color: #10a37f18; color: #10a37f;">${PROVIDER_ICONS.openai}</div>
                    <h3 style="margin: 0; font-size: 20px; font-weight: 600; color: #f4f4f5;">Add Custom AI Model</h3>
                </div>
                <button id="agy-modal-close" style="background: transparent; border: none; color: #a1a1aa; cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.15s ease;">&times;</button>
            </div>

            <div style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px;">
                <!-- Provider -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">API Provider</label>
                    <select id="agy-provider" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; cursor: pointer; transition: border-color 0.15s ease;">
                        <option value="openai">OpenAI (ChatGPT)</option>
                        <option value="anthropic">Anthropic (Claude)</option>
                        <option value="google">Google AI Studio (Gemini)</option>
                        <option value="ollama">Ollama (Local)</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="custom">Custom / Other</option>
                    </select>
                </div>

                <!-- Model ID -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">Model Name / ID <span style="color: #ef4444;">*</span></label>
                    <input type="text" id="agy-model-id" placeholder="e.g. gpt-4o" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" required />
                    <div id="agy-model-id-error" style="font-size: 11px; color: #ef4444; display: none; margin-top: 2px;"></div>
                </div>

                <!-- Friendly Display Name -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">Friendly Display Name</label>
                    <input type="text" id="agy-display-name" placeholder="e.g. GPT-4o (OpenAI)" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" />
                </div>

                <!-- API Key -->
                <div id="agy-key-container" style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">API Key <span id="agy-key-required" style="color: #ef4444;">*</span></label>
                    <input type="password" id="agy-api-key" placeholder="Enter API key" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" />
                </div>

                <!-- API URL -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">API URL <span style="color: #ef4444;">*</span></label>
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <input type="text" id="agy-api-url" placeholder="https://api.openai.com/v1/chat/completions" style="flex: 1; background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" required />
                        <div id="agy-url-status" style="width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background-color: #71717a; transition: background-color 0.3s ease;" title="URL not yet validated"></div>
                    </div>
                    <div id="agy-url-error" style="font-size: 11px; color: #ef4444; display: none; margin-top: 2px;"></div>
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center;">
                <button id="agy-btn-test" style="background-color: transparent; border: 1px solid #3f3f46; border-radius: 8px; color: #a1a1aa; padding: 10px 14px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                    Test Connection
                </button>
                <div style="display: flex; gap: 12px;">
                    <button id="agy-btn-cancel" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; padding: 10px 18px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease;">Cancel</button>
                    <button id="agy-btn-save" style="background-color: #e4e4e7; border: none; border-radius: 8px; color: #18181b; padding: 10px 22px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background-color 0.15s ease, opacity 0.15s ease;">Save Model</button>
                </div>
            </div>
        `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Animate in
    setTimeout(() => {
      overlay.style.opacity = '1';
      modal.style.transform = 'scale(1) translateY(0)';
    }, 10);

    // Close handler
    const closeModal = () => {
      overlay.style.opacity = '0';
      modal.style.transform = 'scale(0.9) translateY(20px)';
      setTimeout(() => overlay.remove(), 200);
    };

    document.getElementById('agy-modal-close')!.addEventListener('click', closeModal);
    document.getElementById('agy-btn-cancel')!.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const providerSelect = document.getElementById('agy-provider') as HTMLSelectElement;
    const urlInput = document.getElementById('agy-api-url') as HTMLInputElement;
    const keyContainer = document.getElementById('agy-key-container')!;
    const keyInput = document.getElementById('agy-api-key') as HTMLInputElement;
    const modelInput = document.getElementById('agy-model-id') as HTMLInputElement;
    const nameInput = document.getElementById('agy-display-name') as HTMLInputElement;
    const urlStatus = document.getElementById('agy-url-status')!;
    const urlError = document.getElementById('agy-url-error')!;
    const modelIdError = document.getElementById('agy-model-id-error')!;
    const providerIcon = document.getElementById('agy-modal-provider-icon')!;
    const keyRequired = document.getElementById('agy-key-required')!;
    const testBtn = document.getElementById('agy-btn-test') as HTMLButtonElement;
    const saveBtn = document.getElementById('agy-btn-save') as HTMLButtonElement;

    const prefilledUrls: Record<string, string> = {
      openai: 'https://api.openai.com/v1/chat/completions',
      anthropic: 'https://api.anthropic.com/v1/messages',
      ollama: 'http://localhost:11434/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      custom: '',
    };

    // Real-time URL validation
    const validateUrl = () => {
      const val = urlInput.value.trim();
      if (!val) {
        urlStatus.style.backgroundColor = '#71717a';
        urlStatus.title = 'URL required';
        return;
      }
      try {
        const u = new URL(val);
        if (['http:', 'https:'].includes(u.protocol)) {
          urlStatus.style.backgroundColor = '#22c55e';
          urlStatus.title = 'Valid URL format';
          urlError.style.display = 'none';
        } else {
          urlStatus.style.backgroundColor = '#fbbf24';
          urlStatus.title = 'URL must use http or https';
        }
      } catch {
        urlStatus.style.backgroundColor = '#ef4444';
        urlStatus.title = 'Invalid URL format';
        urlError.textContent = 'Please enter a valid URL (e.g. https://api.openai.com/v1)';
        urlError.style.display = 'block';
      }
    };

    // Model ID validation
    const validateModelId = () => {
      const val = modelInput.value.trim();
      if (val && !/^[a-zA-Z0-9._-]+$/.test(val)) {
        modelIdError.textContent = 'Use only letters, numbers, dots, hyphens, underscores';
        modelIdError.style.display = 'block';
        modelInput.style.borderColor = '#ef4444';
      } else {
        modelIdError.style.display = 'none';
        modelInput.style.borderColor = '#3f3f46';
      }
    };

    urlInput.addEventListener('input', validateUrl);
    modelInput.addEventListener('input', () => {
      validateModelId();
      if (providerSelect.value === 'google') {
        const modelId = modelInput.value.trim() || 'model-name';
        urlInput.value = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
        validateUrl();
      }
    });

    const updatePrefills = () => {
      const val = providerSelect.value;
      const modelId = modelInput.value.trim() || 'model-name';

      if (val === 'google') {
        urlInput.value = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
      } else {
        urlInput.value = prefilledUrls[val] || '';
      }

      // Update provider icon
      providerIcon.style.backgroundColor = getProviderColor(val) + '18';
      providerIcon.style.color = getProviderColor(val);
      providerIcon.innerHTML = getProviderIcon(val);

      // Update key requirement indicator
      if (val === 'ollama') {
        keyContainer.style.display = 'none';
        keyInput.value = '';
        keyRequired.style.display = 'none';
        modelInput.placeholder = 'e.g. llama3';
        nameInput.placeholder = 'e.g. Llama 3 (Ollama)';
      } else {
        keyContainer.style.display = 'flex';
        keyRequired.style.display = 'inline';
        if (val === 'openai') {
          modelInput.placeholder = 'e.g. gpt-4o';
          nameInput.placeholder = 'e.g. GPT-4o (OpenAI)';
        } else if (val === 'anthropic') {
          modelInput.placeholder = 'e.g. claude-3-5-sonnet-latest';
          nameInput.placeholder = 'e.g. Claude 3.5 Sonnet';
        } else if (val === 'google') {
          modelInput.placeholder = 'e.g. gemini-2.0-flash';
          nameInput.placeholder = 'e.g. Gemini 2.0 Flash';
        } else {
          modelInput.placeholder = 'e.g. model-name';
          nameInput.placeholder = 'e.g. My Custom Model';
        }
      }

      validateUrl();
    };

    providerSelect.addEventListener('change', updatePrefills);

    // ─── Test Connection in Modal ────────────────────
    testBtn.addEventListener('click', async () => {
      const provider = providerSelect.value;
      const modelId = modelInput.value.trim();
      const apiKey = keyInput.value.trim();
      const apiUrl = urlInput.value.trim();

      if (!apiUrl) {
        alert('Please enter an API URL first');
        return;
      }

      testBtn.disabled = true;
      testBtn.style.cursor = 'wait';
      testBtn.style.color = '#fbbf24';
      testBtn.style.borderColor = '#fbbf24';
      const originalHtml = testBtn.innerHTML;
      testBtn.innerHTML = '<span>Testing...</span>';

      try {
        const result = await storageAPI.testModelConnection({
          apiUrl,
          provider,
          apiKey,
        });

        if (result.success) {
          urlStatus.style.backgroundColor = '#22c55e';
          urlStatus.title = result.message || 'Connection successful!';
          testBtn.style.color = '#22c55e';
          testBtn.style.borderColor = '#22c55e';
        } else {
          urlStatus.style.backgroundColor = '#ef4444';
          urlStatus.title = result.error || 'Connection failed';
          testBtn.style.color = '#ef4444';
          testBtn.style.borderColor = '#ef4444';
        }
      } catch (err) {
        urlStatus.style.backgroundColor = '#ef4444';
        urlStatus.title = 'Test connection failed';
        testBtn.style.color = '#ef4444';
        testBtn.style.borderColor = '#ef4444';
      }

      setTimeout(() => {
        testBtn.disabled = false;
        testBtn.style.cursor = 'pointer';
        testBtn.style.color = '#a1a1aa';
        testBtn.style.borderColor = '#3f3f46';
        testBtn.innerHTML = originalHtml;
      }, 3000);
    });

    saveBtn.addEventListener('click', async () => {
      const provider = providerSelect.value;
      const modelId = modelInput.value.trim();
      let displayName = nameInput.value.trim();
      const apiKey = keyInput.value.trim();
      const apiUrl = urlInput.value.trim();

      // Clear previous errors
      modelIdError.style.display = 'none';
      urlError.style.display = 'none';
      modelInput.style.borderColor = '#3f3f46';
      urlInput.style.borderColor = '#3f3f46';

      let hasError = false;

      if (!modelId) {
        modelIdError.textContent = 'Model ID is required';
        modelIdError.style.display = 'block';
        modelInput.style.borderColor = '#ef4444';
        hasError = true;
      } else if (!/^[a-zA-Z0-9._-]+$/.test(modelId)) {
        modelIdError.textContent = 'Use only letters, numbers, dots, hyphens, underscores';
        modelIdError.style.display = 'block';
        modelInput.style.borderColor = '#ef4444';
        hasError = true;
      }

      if (provider !== 'ollama' && !apiKey) {
        alert('API Key is required.');
        hasError = true;
      }

      if (!apiUrl) {
        urlError.textContent = 'API URL is required';
        urlError.style.display = 'block';
        urlInput.style.borderColor = '#ef4444';
        hasError = true;
      } else {
        try {
          const u = new URL(apiUrl);
          if (!['http:', 'https:'].includes(u.protocol)) {
            urlError.textContent = 'URL must start with http:// or https://';
            urlError.style.display = 'block';
            urlInput.style.borderColor = '#ef4444';
            hasError = true;
          }
        } catch {
          urlError.textContent = 'Invalid URL format';
          urlError.style.display = 'block';
          urlInput.style.borderColor = '#ef4444';
          hasError = true;
        }
      }

      if (hasError) return;

      if (!displayName) {
        const providerNames: Record<string, string> = {
          openai: 'OpenAI',
          anthropic: 'Anthropic',
          google: 'Google Studio',
          ollama: 'Ollama',
          openrouter: 'OpenRouter',
          custom: 'Custom',
        };
        displayName = `${modelId} (${providerNames[provider]})`;
      }

      const newModel: CustomModelEntry = {
        name: 'models/' + modelId,
        displayName: displayName,
        description: `${displayName} custom model redirected through local proxy`,
        provider: provider,
        apiKey: apiKey || 'none',
        apiUrl: apiUrl,
        externalModelName: modelId,
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        const res = await storageAPI.saveCustomModel(newModel);
        if (res && res.success) {
          closeModal();

          // Re-render the custom models list immediately!
          await renderCustomModelsList();

          // Trigger native refresh button if available
          const refreshBtn = findRefreshButton();
          if (refreshBtn) {
            refreshBtn.click();
          }
        } else {
          alert('Failed to save model: ' + (res?.error || 'Unknown error'));
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Model';
        }
      } catch (err) {
        alert('Error saving model: ' + (err as Error).message);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Model';
      }
    });
  }

  // Efficient DOM tracking via MutationObserver — instead of setInterval
  let injectionObserver: MutationObserver | null = null;
  let injectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function setupInjectionObserver(): void {
    // Try immediately first
    void injectCustomModelsSection();

    // If already added, no need for observer
    if (document.getElementById('agy-custom-models-section')) return;

    // Set up observer: watch all changes under document.body
    injectionObserver = new MutationObserver(() => {
      // Debounce: coalesce consecutive mutations into a single attempt
      if (injectionDebounceTimer) clearTimeout(injectionDebounceTimer);
      injectionDebounceTimer = setTimeout(async () => {
        await injectCustomModelsSection();
        // If successfully injected, stop observing
        if (document.getElementById('agy-custom-models-section')) {
          if (injectionObserver) {
            injectionObserver.disconnect();
            injectionObserver = null;
          }
        }
      }, 200);
    });

    injectionObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // URL tracking for re-injection on SPA page transitions
  let lastUrl = location.href;
  setInterval(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      // Page changed — clean up previous observer and re-initialize
      if (injectionObserver) {
        injectionObserver.disconnect();
        injectionObserver = null;
      }
      // Re-initialize after a short delay (for new DOM to render)
      setTimeout(setupInjectionObserver, 500);
    }
  }, 1500);

  // Start the observer on initial load
  setupInjectionObserver();
});
