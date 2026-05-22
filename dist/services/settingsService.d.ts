export declare enum SettingKey {
    RUN_IN_BACKGROUND = "runInBackground",
    KEEP_COMPUTER_AWAKE = "keepComputerAwake"
}
export declare const DEFAULTS: Map<SettingKey, boolean>;
interface StorageManager {
    onDidChange(listener: (changes: Record<string, string | null>) => void): {
        dispose(): void;
    };
    getItems(): Promise<Record<string, string | null>>;
}
/**
 * A thin wrapper around StorageManager to listen for changes
 * in settings and apply their side effects.
 */
export declare class SettingsService {
    private storageManager;
    constructor(storageManager: StorageManager);
    initialize(): Promise<void>;
    applySideEffects(settings: Record<string, string | null>): void;
    getSetting(key: SettingKey): Promise<boolean>;
}
export {};
//# sourceMappingURL=settingsService.d.ts.map