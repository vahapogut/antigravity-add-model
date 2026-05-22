/**
 * IDE Install Wizard — Window orchestration and IPC handlers.
 */
import { StorageManager } from '../storage';
/**
 * Shows the IDE install wizard as a modal window.
 * Returns a promise that resolves when the wizard is dismissed.
 */
export declare function showIdeInstallWizard(): Promise<void>;
/**
 * Checks conditions and shows the IDE install wizard if appropriate.
 * This should be called early in the app lifecycle, before the LS starts.
 * Returns true if the wizard was shown, false otherwise.
 */
export declare function maybeShowIdeInstallWizard(storageManager: StorageManager): Promise<boolean>;
//# sourceMappingURL=wizard.d.ts.map