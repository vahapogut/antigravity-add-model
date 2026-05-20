"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Preload script — runs in every BrowserWindow before the page loads.
 * Exposes a minimal, secure API via contextBridge so the renderer can
 * communicate with the main-process auto-updater without nodeIntegration.
 */
const electron_1 = require("electron");
const updaterAPI = {
    onStateChanged: (callback) => {
        const handler = (_event, state) => {
            callback(state);
        };
        electron_1.ipcRenderer.on('updater:state-changed', handler);
        // Return unsubscribe function
        return () => {
            electron_1.ipcRenderer.removeListener('updater:state-changed', handler);
        };
    },
    applyUpdate: () => electron_1.ipcRenderer.invoke('updater:apply'),
    quitAndInstall: () => electron_1.ipcRenderer.invoke('updater:quit-and-install'),
    checkForUpdates: () => electron_1.ipcRenderer.invoke('updater:check-for-updates'),
};
const dialogAPI = {
    showOpenDialog: () => electron_1.ipcRenderer.invoke('dialog:open-workspace'),
};
const notificationAPI = {
    send: (options) => electron_1.ipcRenderer.invoke('notification:send', options),
    openSystemPreferences: () => electron_1.ipcRenderer.invoke('notification:open-system-preferences'),
    onClicked: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };
        electron_1.ipcRenderer.on('notification:clicked', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('notification:clicked', handler);
        };
    },
};
const storageAPI = {
    getItems: () => electron_1.ipcRenderer.invoke('storage:get-items'),
    updateItems: (changes) => electron_1.ipcRenderer.invoke('storage:update-items', changes),
    onChanged: (callback) => {
        const handler = (_event, changes) => {
            callback(changes);
        };
        electron_1.ipcRenderer.on('storage:changed', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('storage:changed', handler);
        };
    },
    getCustomModels: () => electron_1.ipcRenderer.invoke('storage:get-custom-models'),
    saveCustomModel: (model) => electron_1.ipcRenderer.invoke('storage:save-custom-model', model),
    deleteCustomModel: (modelName) => electron_1.ipcRenderer.invoke('storage:delete-custom-model', modelName),
};
const logsAPI = {
    getElectronLogs: () => electron_1.ipcRenderer.invoke('logs:electron'),
};
const extensionsAPI = {
    sendAuthorities: (authoritiesMap) => electron_1.ipcRenderer.invoke('extensions:send-authorities', authoritiesMap),
};
const deepLinkAPI = {
    onDeepLink: (callback) => {
        const handler = (_event, url) => {
            callback(url);
        };
        electron_1.ipcRenderer.on('deep-link', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('deep-link', handler);
        };
    },
    getStoredDeepLink: () => electron_1.ipcRenderer.invoke('deep-link:get-stored'),
};
const agentAPI = {
    updateActiveAgentCount: (count) => electron_1.ipcRenderer.invoke('agent:update-active-count', count),
};
const electronNativeAPI = {
    getZoomLevel: () => electron_1.webFrame.getZoomFactor(),
    setTitleBarOverlay: (options) => electron_1.ipcRenderer.invoke('window:set-title-bar-overlay', options),
    minimize: () => electron_1.ipcRenderer.invoke('window:minimize'),
    maximize: () => electron_1.ipcRenderer.invoke('window:maximize'),
    unmaximize: () => electron_1.ipcRenderer.invoke('window:unmaximize'),
    isMaximized: () => electron_1.ipcRenderer.invoke('window:is-maximized'),
    close: () => electron_1.ipcRenderer.invoke('window:close'),
    toggleDevTools: () => electron_1.ipcRenderer.invoke('window:toggle-devtools'),
    zoomIn: () => {
        const current = electron_1.webFrame.getZoomLevel();
        electron_1.webFrame.setZoomLevel(current + 0.5);
    },
    zoomOut: () => {
        const current = electron_1.webFrame.getZoomLevel();
        electron_1.webFrame.setZoomLevel(current - 0.5);
    },
    resetZoom: () => {
        electron_1.webFrame.setZoomLevel(0);
    },
    openExternal: (url) => electron_1.ipcRenderer.invoke('shell:open-external', url),
};
electron_1.contextBridge.exposeInMainWorld('electronUpdater', updaterAPI);
electron_1.contextBridge.exposeInMainWorld('dialog', dialogAPI);
electron_1.contextBridge.exposeInMainWorld('nativeNotifications', notificationAPI);
electron_1.contextBridge.exposeInMainWorld('nativeStorage', storageAPI);
electron_1.contextBridge.exposeInMainWorld('logs', logsAPI);
electron_1.contextBridge.exposeInMainWorld('extensions', extensionsAPI);
electron_1.contextBridge.exposeInMainWorld('deepLink', deepLinkAPI);
electron_1.contextBridge.exposeInMainWorld('agent', agentAPI);
electron_1.contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);

window.addEventListener('DOMContentLoaded', () => {
    // 1. DOM helper functions to detect the "Models" settings tab
    function findRefreshButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Refresh');
    }
    
    function findQuotaElement() {
        const elements = Array.from(document.querySelectorAll('div, p, span'));
        return elements.find(el => {
            const text = el.textContent || '';
            return text.includes('View your available model quota') || 
                   (text.toLowerCase().includes('model quota') && text.length < 150);
        });
    }

    function isModelsTabActive() {
        return !!findRefreshButton() && !!findQuotaElement();
    }

    // 2. Main check and injection function
    async function injectCustomModelsUI() {
        if (!isModelsTabActive()) {
            return;
        }

        // Avoid duplicate injections
        if (document.getElementById('agy-custom-models-section')) {
            return;
        }

        const quotaEl = findQuotaElement();
        if (!quotaEl) return;

        // Create section container
        const container = document.createElement('div');
        container.id = 'agy-custom-models-section';
        container.style.border = '1px solid #27272a';
        container.style.backgroundColor = '#18181b';
        container.style.borderRadius = '12px';
        container.style.padding = '24px';
        container.style.marginBottom = '24px';
        container.style.marginTop = '16px';
        container.style.color = '#f4f4f5';
        container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
        container.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';

        // Insert container right above the quota element
        quotaEl.parentNode.insertBefore(container, quotaEl);

        // Render contents
        await renderCustomModelsUI(container);
    }

    // 3. Render HTML Structure
    async function renderCustomModelsUI(container) {
        container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 24px;">
                <!-- Header -->
                <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #27272a; padding-bottom: 12px;">
                    <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #ffffff;">Custom AI Models</h3>
                    <span style="font-size: 11px; color: #a1a1aa; background-color: #27272a; padding: 4px 8px; border-radius: 12px; border: 1px solid #3f3f46;">Local Proxy Integration</span>
                </div>

                <!-- List of Saved Models -->
                <div>
                    <h4 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 500; color: #a1a1aa;">Saved Custom Models</h4>
                    <div id="agy-models-list" style="display: flex; flex-direction: column; gap: 8px;">
                        <div style="color: #71717a; font-size: 13px; padding: 12px; text-align: center; background-color: #0f0f11; border: 1px dashed #27272a; border-radius: 8px;">
                            Loading models...
                        </div>
                    </div>
                </div>

                <!-- Divider -->
                <div style="height: 1px; background-color: #27272a;"></div>

                <!-- Add Model Form -->
                <div>
                    <h4 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 500; color: #a1a1aa;">Add Custom Model</h4>
                    
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 16px;">
                        <!-- Provider -->
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 12px; font-weight: 500; color: #a1a1aa;">API Provider</label>
                            <select id="agy-provider" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #f4f4f5; padding: 8px 12px; font-size: 13px; outline: none; cursor: pointer; transition: all 0.15s ease;">
                                <option value="openai">OpenAI (ChatGPT)</option>
                                <option value="anthropic">Anthropic (Claude)</option>
                                <option value="google">Google AI Studio (Gemini)</option>
                                <option value="ollama">Ollama (Local)</option>
                                <option value="custom">Custom / Other</option>
                            </select>
                        </div>
                        
                        <!-- Model ID -->
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 12px; font-weight: 500; color: #a1a1aa;">Model Name / ID</label>
                            <input type="text" id="agy-model-id" placeholder="e.g. gpt-4o" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #f4f4f5; padding: 8px 12px; font-size: 13px; outline: none; transition: all 0.15s ease;" required />
                        </div>
                        
                        <!-- Friendly Display Name -->
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 12px; font-weight: 500; color: #a1a1aa;">Friendly Display Name</label>
                            <input type="text" id="agy-display-name" placeholder="e.g. GPT-4o" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #f4f4f5; padding: 8px 12px; font-size: 13px; outline: none; transition: all 0.15s ease;" />
                        </div>
                        
                        <!-- API Key -->
                        <div id="agy-key-container" style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 12px; font-weight: 500; color: #a1a1aa;">API Key</label>
                            <input type="password" id="agy-api-key" placeholder="Enter API key" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #f4f4f5; padding: 8px 12px; font-size: 13px; outline: none; transition: all 0.15s ease;" />
                        </div>
                    </div>
                    
                    <!-- API URL (Span Full Width) -->
                    <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px;">
                        <label style="font-size: 12px; font-weight: 500; color: #a1a1aa;">API URL</label>
                        <input type="text" id="agy-api-url" placeholder="https://api.openai.com/v1/chat/completions" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #f4f4f5; padding: 8px 12px; font-size: 13px; outline: none; transition: all 0.15s ease;" required />
                    </div>
                    
                    <!-- Form Actions -->
                    <div style="display: flex; justify-content: flex-end; gap: 12px;">
                        <button id="agy-btn-clear" style="background-color: transparent; border: 1px solid #3f3f46; border-radius: 6px; color: #a1a1aa; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease;">Clear Form</button>
                        <button id="agy-btn-save" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 6px; color: #ffffff; padding: 8px 20px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease;">Save Model</button>
                    </div>
                </div>
            </div>
        `;

        setupFormBehavior(container);
        await refreshModelsList(container);
    }

    // 4. Input focus styling and prefill hooks
    function setupFormBehavior(container) {
        const providerSelect = container.querySelector('#agy-provider');
        const urlInput = container.querySelector('#agy-api-url');
        const keyContainer = container.querySelector('#agy-key-container');
        const keyInput = container.querySelector('#agy-api-key');
        const modelInput = container.querySelector('#agy-model-id');
        const nameInput = container.querySelector('#agy-display-name');
        const saveBtn = container.querySelector('#agy-btn-save');
        const clearBtn = container.querySelector('#agy-btn-clear');

        const prefilledUrls = {
            openai: 'https://api.openai.com/v1/chat/completions',
            anthropic: 'https://api.anthropic.com/v1/messages',
            ollama: 'http://localhost:11434/v1/chat/completions',
            custom: ''
        };

        const updatePrefills = () => {
            const val = providerSelect.value;
            const modelId = modelInput.value.trim() || 'model-name';
            
            if (val === 'google') {
                urlInput.value = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
            } else {
                urlInput.value = prefilledUrls[val] || '';
            }
            
            if (val === 'ollama') {
                keyContainer.style.display = 'none';
                keyInput.value = '';
                modelInput.placeholder = 'e.g. llama3';
                nameInput.placeholder = 'e.g. Llama 3 (Ollama)';
            } else {
                keyContainer.style.display = 'flex';
                if (val === 'openai') {
                    modelInput.placeholder = 'e.g. gpt-4o';
                    nameInput.placeholder = 'e.g. GPT-4o (OpenAI)';
                } else if (val === 'anthropic') {
                    modelInput.placeholder = 'e.g. claude-3-5-sonnet-latest';
                    nameInput.placeholder = 'e.g. Claude 3.5 Sonnet';
                } else if (val === 'google') {
                    modelInput.placeholder = 'e.g. gemini-1.5-pro';
                    nameInput.placeholder = 'e.g. Gemini 1.5 Pro (Google)';
                } else {
                    modelInput.placeholder = 'e.g. custom-model';
                    nameInput.placeholder = 'e.g. My Custom Model';
                }
            }
        };

        // Listen for input on modelId to update Google URL dynamically!
        modelInput.addEventListener('input', () => {
            if (providerSelect.value === 'google') {
                const modelId = modelInput.value.trim() || 'model-name';
                urlInput.value = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
            }
        });

        providerSelect.addEventListener('change', updatePrefills);
        updatePrefills();

        // Standard, professional focus styling
        const inputs = [providerSelect, urlInput, keyInput, modelInput, nameInput];
        inputs.forEach(input => {
            input.addEventListener('focus', () => {
                input.style.borderColor = '#71717a';
                input.style.boxShadow = '0 0 0 1px #71717a';
            });
            input.addEventListener('blur', () => {
                input.style.borderColor = '#3f3f46';
                input.style.boxShadow = 'none';
            });
        });

        // Hover animations and transitions for buttons
        saveBtn.addEventListener('mouseenter', () => {
            saveBtn.style.backgroundColor = '#3f3f46';
            saveBtn.style.borderColor = '#52525b';
        });
        saveBtn.addEventListener('mouseleave', () => {
            saveBtn.style.backgroundColor = '#27272a';
            saveBtn.style.borderColor = '#3f3f46';
        });

        clearBtn.addEventListener('mouseenter', () => {
            clearBtn.style.backgroundColor = '#27272a';
            clearBtn.style.color = '#ffffff';
        });
        clearBtn.addEventListener('mouseleave', () => {
            clearBtn.style.backgroundColor = 'transparent';
            clearBtn.style.color = '#a1a1aa';
        });

        clearBtn.addEventListener('click', () => {
            modelInput.value = '';
            nameInput.value = '';
            keyInput.value = '';
            providerSelect.value = 'openai';
            updatePrefills();
        });

        saveBtn.addEventListener('click', async () => {
            const provider = providerSelect.value;
            const modelId = modelInput.value.trim();
            let displayName = nameInput.value.trim();
            const apiKey = keyInput.value.trim();
            const apiUrl = urlInput.value.trim();
            
            if (!modelId) {
                alert('Model ID is required.');
                return;
            }
            
            if (provider !== 'ollama' && !apiKey) {
                alert('API Key is required.');
                return;
            }
            
            if (!apiUrl) {
                alert('API URL is required.');
                return;
            }
            
            if (!displayName) {
                const providerNames = {
                    openai: 'OpenAI',
                    anthropic: 'Anthropic',
                    google: 'Google Studio',
                    ollama: 'Ollama',
                    custom: 'Custom'
                };
                displayName = `${modelId} (${providerNames[provider]})`;
            }
            
            const newModel = {
                name: 'models/' + modelId,
                displayName: displayName,
                description: `${displayName} custom model redirected through local proxy`,
                provider: provider,
                apiKey: apiKey || 'none',
                apiUrl: apiUrl,
                externalModelName: modelId
            };
            
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            
            try {
                const res = await window.nativeStorage.saveCustomModel(newModel);
                if (res && res.success) {
                    // Reset input fields
                    modelInput.value = '';
                    nameInput.value = '';
                    keyInput.value = '';
                    updatePrefills();
                    
                    // Refresh current models list
                    await refreshModelsList(container);
                    
                    // Trigger native refresh button if available to let app select it immediately
                    const refreshBtn = findRefreshButton();
                    if (refreshBtn) {
                        refreshBtn.click();
                    }
                } else {
                    alert('Failed to save model: ' + (res?.error || 'Unknown error'));
                }
            } catch (err) {
                alert('Error saving model: ' + err.message);
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Model';
            }
        });
    }

    // 5. Load and dynamically build saved models list
    async function refreshModelsList(container) {
        const listContainer = container.querySelector('#agy-models-list');
        if (!listContainer) return;

        try {
            const models = await window.nativeStorage.getCustomModels();
            if (!models || models.length === 0) {
                listContainer.innerHTML = `
                    <div style="color: #71717a; font-size: 13px; padding: 16px; text-align: center; background-color: #0f0f11; border: 1px dashed #27272a; border-radius: 8px;">
                        No custom models added yet. Add your first custom model below!
                    </div>
                `;
                return;
            }

            listContainer.innerHTML = '';
            models.forEach(model => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.justifyContent = 'space-between';
                item.style.backgroundColor = '#27272a';
                item.style.border = '1px solid #3f3f46';
                item.style.borderRadius = '8px';
                item.style.padding = '12px 16px';
                item.style.transition = 'all 0.15s ease';

                const left = document.createElement('div');
                left.style.display = 'flex';
                left.style.flexDirection = 'column';
                left.style.gap = '4px';

                const nameText = document.createElement('span');
                nameText.textContent = model.displayName;
                nameText.style.fontSize = '14px';
                nameText.style.fontWeight = '500';
                nameText.style.color = '#ffffff';

                const detailsText = document.createElement('span');
                const providerFormatted = model.provider ? model.provider.toUpperCase() : 'CUSTOM';
                detailsText.textContent = `${model.name.replace('models/', '')} • ${providerFormatted} • ${model.apiUrl}`;
                detailsText.style.fontSize = '11px';
                detailsText.style.color = '#a1a1aa';

                left.appendChild(nameText);
                left.appendChild(detailsText);

                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Delete';
                deleteBtn.style.backgroundColor = 'transparent';
                deleteBtn.style.border = '1px solid #ef4444';
                deleteBtn.style.color = '#ef4444';
                deleteBtn.style.borderRadius = '4px';
                deleteBtn.style.padding = '4px 10px';
                deleteBtn.style.fontSize = '12px';
                deleteBtn.style.fontWeight = '500';
                deleteBtn.style.cursor = 'pointer';
                deleteBtn.style.transition = 'all 0.15s ease';

                deleteBtn.addEventListener('mouseenter', () => {
                    deleteBtn.style.backgroundColor = '#ef4444';
                    deleteBtn.style.color = '#ffffff';
                });
                deleteBtn.addEventListener('mouseleave', () => {
                    deleteBtn.style.backgroundColor = 'transparent';
                    deleteBtn.style.color = '#ef4444';
                });

                deleteBtn.addEventListener('click', async () => {
                    if (confirm(`Are you sure you want to delete "${model.displayName}"?`)) {
                        deleteBtn.disabled = true;
                        deleteBtn.textContent = 'Deleting...';
                        try {
                            const res = await window.nativeStorage.deleteCustomModel(model.name);
                            if (res && res.success) {
                                await refreshModelsList(container);
                                const refreshBtn = findRefreshButton();
                                if (refreshBtn) {
                                    refreshBtn.click();
                                }
                            } else {
                                alert('Failed to delete model: ' + (res?.error || 'Unknown error'));
                                deleteBtn.disabled = false;
                                deleteBtn.textContent = 'Delete';
                            }
                        } catch (err) {
                            alert('Error deleting model: ' + err.message);
                            deleteBtn.disabled = false;
                            deleteBtn.textContent = 'Delete';
                        }
                    }
                });

                item.appendChild(left);
                item.appendChild(deleteBtn);
                listContainer.appendChild(item);
            });
        } catch (err) {
            listContainer.innerHTML = `
                <div style="color: #ef4444; font-size: 13px; padding: 12px; text-align: center; background-color: #0f0f11; border: 1px dashed #ef4444; border-radius: 8px;">
                    Error loading models: ${err.message}
                </div>
            `;
        }
    }

    // 6. Check DOM periodically (every 1s) to seamlessly inject the UI
    setInterval(injectCustomModelsUI, 1000);
});
