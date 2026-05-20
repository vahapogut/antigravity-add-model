"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Preload script for the IDE Install Wizard window.
 *
 * This is a minimal, self-contained preload that exposes only the APIs
 * needed by the wizard's inline HTML UI. It runs in its own
 * BrowserWindow, separate from the main app window and its preload.
 */
const electron_1 = require("electron");
const wizardAPI = {
    completeWizard: (shouldDownload) => electron_1.ipcRenderer.invoke('wizard:complete', shouldDownload),
    onSetupComplete: (callback) => {
        const handler = () => {
            callback();
        };
        electron_1.ipcRenderer.on('wizard:setup-complete', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('wizard:setup-complete', handler);
        };
    },
};
electron_1.contextBridge.exposeInMainWorld('wizardAPI', wizardAPI);
