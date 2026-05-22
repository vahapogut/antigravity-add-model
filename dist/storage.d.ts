/**
 * Manages persistent storage for the application.
 * Stores key-value pairs.
 */
export declare class StorageManager {
    private storagePath;
    private defaults;
    private emitter;
    onDidChange: (listener: (changes: Record<string, string | null>) => void) => {
        dispose(): void;
    };
    constructor(storagePath: string, defaults?: Map<string, boolean>);
    /**
     * Gets raw items from the storage file.
     */
    getRawItems(): Promise<Record<string, string>>;
    /**
     * Gets all items from the storage, with defaults applied.
     *
     * @returns A record of key-value pairs.
     */
    getItems(): Promise<Record<string, string | null>>;
    /**
     * Updates items in the storage.
     *
     * @param changes A record of key-value pairs to update. If a value is null, the key will be deleted.
     */
    updateItems(changes: Record<string, string | null>): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map