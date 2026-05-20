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
    
    function hasModelsHeading() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, div'));
        return headings.some(h => h.textContent.trim() === 'Models');
    }
    
    function injectAddModelUI() {
        const refreshBtn = findRefreshButton();
        if (!refreshBtn) return;
        if (!hasModelsHeading()) return;
        if (document.getElementById('agy-add-model-btn')) return;
        
        const addModelBtn = document.createElement('button');
        addModelBtn.id = 'agy-add-model-btn';
        addModelBtn.textContent = 'Add Model';
        
        // Copy classes from Refresh button to match native styling exactly!
        addModelBtn.className = refreshBtn.className;
        
        // Inherit native button look completely (no custom purple gradients)
        addModelBtn.style.marginRight = '12px';
        addModelBtn.style.cursor = 'pointer';
        
        // Insert it right before the Refresh button
        refreshBtn.parentNode.insertBefore(addModelBtn, refreshBtn);
        
        addModelBtn.addEventListener('click', () => {
            openAddModelModal();
        });
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
    
    // Check DOM periodically (every 1s) to inject the UI element seamlessly
    setInterval(injectAddModelUI, 1000);
});
