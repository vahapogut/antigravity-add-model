export declare enum MenuUpdateStep {
    CheckForUpdates = "Check for Updates",
    CheckingForUpdates = "Checking for Updates...",
    DownloadingUpdate = "Downloading Update...",
    RestartToUpdate = "Restart to Update"
}
export declare const updateActions: Record<string, (() => void) | undefined>;
interface UpdaterState {
    type: string;
    update?: {
        version: string;
    };
}
/** Broadcast a state change to every open BrowserWindow. */
export declare function broadcastState(state: UpdaterState): void;
/**
 * Initializes the auto-updater and registers IPC handlers.
 * Call once after the first window is created.
 *
 * The updater will:
 * 1. Wait INITIAL_CHECK_DELAY_MS ms, then check for updates.
 * 2. Re-check every CHECK_INTERVAL_MS ms.
 * 3. Download updates automatically in the background.
 * 4. Broadcast state to the renderer so AppUpdateButton can display progress.
 */
export declare function initAutoUpdater(isHeadless: boolean): void;
export declare function checkForUpdates(isManual?: boolean): void;
export declare function quitAndInstall(): void;
export {};
//# sourceMappingURL=updater.d.ts.map