/**
 * Preload script for the IDE Install Wizard window.
 *
 * This is a minimal, self-contained preload that exposes only the APIs
 * needed by the wizard's inline HTML UI. It runs in its own
 * BrowserWindow, separate from the main app window and its preload.
 */
interface WizardAPI {
    completeWizard: (shouldDownload: boolean) => Promise<void>;
    onSetupComplete: (callback: () => void) => () => void;
}
declare global {
    interface Window {
        wizardAPI: WizardAPI;
    }
}
export {};
//# sourceMappingURL=wizardPreload.d.ts.map