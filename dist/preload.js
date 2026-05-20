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
    function findRefreshButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Refresh');
    }
    
    function findMcpSectionContainer() {
        const refreshBtn = findRefreshButton();
        if (!refreshBtn) return null;
        
        const btnGroup = refreshBtn.parentNode;
        if (!btnGroup) return null;
        
        const headerRow = btnGroup.parentNode;
        if (!headerRow) return null;
        
        const mainContainer = headerRow.parentNode;
        if (!mainContainer) return null;
        
        const contentBlock = headerRow.nextElementSibling;
        
        return {
            mainContainer,
            headerRow,
            contentBlock
        };
    }
    
    async function renderCustomModelsList() {
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
                models.forEach(model => {
                    const item = document.createElement('div');
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    item.style.padding = '12px 16px';
                    item.style.backgroundColor = '#18181b';
                    item.style.border = '1px solid #27272a';
                    item.style.borderRadius = '8px';
                    item.style.transition = 'border-color 0.15s ease';
                    item.style.marginBottom = '8px';
                    
                    item.addEventListener('mouseenter', () => {
                        item.style.borderColor = '#3f3f46';
                    });
                    item.addEventListener('mouseleave', () => {
                        item.style.borderColor = '#27272a';
                    });
                    
                    const info = document.createElement('div');
                    info.style.display = 'flex';
                    info.style.flexDirection = 'column';
                    info.style.gap = '2px';
                    
                    const title = document.createElement('div');
                    title.style.fontSize = '14px';
                    title.style.fontWeight = '500';
                    title.style.color = '#f4f4f5';
                    title.textContent = model.displayName || model.name;
                    
                    const sub = document.createElement('div');
                    sub.style.fontSize = '12px';
                    sub.style.color = '#a1a1aa';
                    const providerText = model.provider.toUpperCase();
                    sub.textContent = `${providerText} • ${model.apiUrl}`;
                    
                    info.appendChild(title);
                    info.appendChild(sub);
                    
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
                            await storageAPI.deleteCustomModel(model.name);
                            await renderCustomModelsList();
                            
                            const refreshBtn = findRefreshButton();
                            if (refreshBtn) refreshBtn.click();
                        }
                    });
                    
                    item.appendChild(info);
                    item.appendChild(deleteBtn);
                    contentArea.appendChild(item);
                });
            }
        } catch (err) {
            console.error('Failed to load custom models in list:', err);
        }
    }
    
    async function injectCustomModelsSection() {
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
        newHeaderRow.className = headerRow.className;
        newHeaderRow.style.cssText = headerRow.style.cssText;
        newHeaderRow.style.display = 'flex';
        newHeaderRow.style.justifyContent = 'space-between';
        newHeaderRow.style.alignItems = 'center';
        newHeaderRow.style.marginBottom = '8px';
        
        const originalHeading = headerRow.firstElementChild;
        const newHeading = document.createElement(originalHeading ? originalHeading.tagName : 'div');
        if (originalHeading) {
            newHeading.className = originalHeading.className;
            newHeading.style.cssText = originalHeading.style.cssText;
        }
        newHeading.textContent = 'Custom Models';
        
        const newBtnGroup = document.createElement('div');
        const originalBtnGroup = headerRow.lastElementChild;
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
    
    function openAddModelModal() {
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
        overlay.style.webkitBackdropFilter = 'blur(6px)';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.zIndex = '999999';
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.2s ease-in-out';
        
        // Modal card container
        const modal = document.createElement('div');
        modal.id = 'agy-modal-card';
        modal.style.width = '480px';
        modal.style.backgroundColor = '#18181b'; // zinc-900 background
        modal.style.border = '1px solid #27272a'; // zinc-800 border
        modal.style.borderRadius = '16px';
        modal.style.padding = '32px';
        modal.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5)';
        modal.style.color = '#f4f4f5'; // zinc-100 text
        modal.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
        modal.style.transform = 'scale(0.9) translateY(20px)';
        modal.style.transition = 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
        
        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                <h3 style="margin: 0; font-size: 20px; font-weight: 600; color: #f4f4f5;">Add Custom AI Model</h3>
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
                        <option value="custom">Custom / Other</option>
                    </select>
                </div>
                
                <!-- Model ID -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">Model Name / ID</label>
                    <input type="text" id="agy-model-id" placeholder="e.g. gpt-4o" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" required />
                </div>
                
                <!-- Friendly Display Name -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">Friendly Display Name</label>
                    <input type="text" id="agy-display-name" placeholder="e.g. GPT-4o (OpenAI)" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" />
                </div>
                
                <!-- API Key -->
                <div id="agy-key-container" style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">API Key</label>
                    <input type="password" id="agy-api-key" placeholder="Enter API key" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" />
                </div>
                
                <!-- API URL -->
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 13px; font-weight: 500; color: #a1a1aa;">API URL</label>
                    <input type="text" id="agy-api-url" placeholder="https://api.openai.com/v1/chat/completions" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #f4f4f5; padding: 10px 12px; font-size: 14px; outline: none; transition: border-color 0.15s ease;" required />
                </div>
            </div>
            
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button id="agy-btn-cancel" style="background-color: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; padding: 10px 18px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease;">Cancel</button>
                <button id="agy-btn-save" style="background-color: #e4e4e7; border: none; border-radius: 8px; color: #18181b; padding: 10px 22px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background-color 0.15s ease, opacity 0.15s ease;">Save Model</button>
            </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            overlay.style.opacity = '1';
            modal.style.transform = 'scale(1) translateY(0)';
        }, 10);
        
        const providerSelect = document.getElementById('agy-provider');
        const urlInput = document.getElementById('agy-api-url');
        const keyContainer = document.getElementById('agy-key-container');
        const keyInput = document.getElementById('agy-api-key');
        const modelInput = document.getElementById('agy-model-id');
        const nameInput = document.getElementById('agy-display-name');
        
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
        
        const closeModal = () => {
            overlay.style.opacity = '0';
            modal.style.transform = 'scale(0.9) translateY(20px)';
            setTimeout(() => {
                overlay.remove();
            }, 200);
        };
        
        document.getElementById('agy-modal-close').addEventListener('click', closeModal);
        
        const cancelBtn = document.getElementById('agy-btn-cancel');
        cancelBtn.addEventListener('click', closeModal);
        
        // Button Hover Effects
        cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.backgroundColor = '#3f3f46'; });
        cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.backgroundColor = '#27272a'; });
        
        const saveBtn = document.getElementById('agy-btn-save');
        saveBtn.addEventListener('mouseenter', () => { saveBtn.style.backgroundColor = '#d4d4d8'; });
        saveBtn.addEventListener('mouseleave', () => { saveBtn.style.backgroundColor = '#e4e4e7'; });
        
        const closeBtn = document.getElementById('agy-modal-close');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#f4f4f5'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#a1a1aa'; });
        
        // Focus Highlights - Native matching slate outline focus
        const inputs = [providerSelect, urlInput, keyInput, modelInput, nameInput];
        inputs.forEach(input => {
            input.addEventListener('focus', () => { input.style.borderColor = '#71717a'; });
            input.addEventListener('blur', () => { input.style.borderColor = '#3f3f46'; });
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
                alert('Error saving model: ' + err.message);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Model';
            }
        });
    }
    
    // MutationObserver ile verimli DOM takibi — setInterval yerine
    let injectionObserver = null;
    let injectionDebounceTimer = null;
    
    function setupInjectionObserver() {
        // Önce hemen dene
        injectCustomModelsSection();
        
        // Zaten eklenmişse observer'a gerek yok
        if (document.getElementById('agy-custom-models-section')) return;
        
        // Observer kur: document.body altındaki tüm değişiklikleri izle
        injectionObserver = new MutationObserver(() => {
            // Debounce: ardışık mutasyonları tek bir denemede birleştir
            if (injectionDebounceTimer) clearTimeout(injectionDebounceTimer);
            injectionDebounceTimer = setTimeout(async () => {
                await injectCustomModelsSection();
                // Başarıyla enjekte edildiyse observer'ı durdur
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
            subtree: true
        });
    }
    
    // SPA sayfa geçişlerinde yeniden enjeksiyon için URL izleme
    let lastUrl = location.href;
    setInterval(() => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            // Sayfa değişti — önceki observer'ı temizle ve yeniden kur
            if (injectionObserver) {
                injectionObserver.disconnect();
                injectionObserver = null;
            }
            // Kısa gecikmeyle yeniden kur (yeni DOM'un oluşması için)
            setTimeout(setupInjectionObserver, 500);
        }
    }, 1500);
    
    // Başlangıçta observer'ı kur
    setupInjectionObserver();
});
