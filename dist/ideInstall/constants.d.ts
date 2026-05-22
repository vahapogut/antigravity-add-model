/**
 * IDE Install — Constants, platform helpers, and condition checks.
 */
import { StorageManager } from '../storage';
export declare const WIZARD_SHOWN_KEY = "ide-install-wizard-shown";
/** Fetches the latest stable IDE download URL for a given platform. */
export declare function fetchIdeDownloadUrl(platformKey: string): Promise<string>;
export declare function getPlatformKey(): string;
/** Returns the expected installation path for the IDE. */
export declare function getIdeInstallPath(): string;
/**
 * Determines whether the IDE install wizard should be shown.
 *
 * Conditions (all must be true):
 * 1. Wizard has not been shown before (checked via storage)
 * 2. `~/.gemini/antigravity-ide` does NOT exist
 * 3. `~/.gemini/antigravity` DOES exist
 */
export declare function shouldShowIdeInstallWizard(storageManager: StorageManager): Promise<boolean>;
//# sourceMappingURL=constants.d.ts.map