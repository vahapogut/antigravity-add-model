/** Set before reading credentials when running the owned Node proxy service. */
export declare function configureCredentialDirectory(directory: string): void;
/**
 * Earlier releases copied the configuration to "<file>.bak" before encrypting it.
 * Remove that copy while it still holds a readable credential; leave any other file alone.
 */
export declare function removePlaintextBackup(filePath: string): boolean;
/**
 * Checks if Electron's safeStorage API is fully functional on the current system.
 */
export declare function isEncryptionAvailable(): boolean;
/**
 * Use OS-backed storage when available; otherwise AES-GCM with a local user key.
 */
export declare function encryptString(plainText: string): string;
/**
 * Decrypts a previously encrypted string. Handles safeStorage, base64 fallback, and plaintext gracefully.
 */
export declare function decryptString(encryptedText: string): string;
/** Re-protect a stored secret kept in clear or in the retired base64 form; other values are returned unchanged. */
export declare function protectStoredSecret(value: string): string;
interface ModelWithKey {
    apiKey?: string;
    encrypted?: boolean;
    provider?: string;
    [key: string]: unknown;
}
/**
 * Iterates through a list of custom models and encrypts their API keys.
 */
export declare function encryptModels(models: ModelWithKey[] | null): ModelWithKey[];
/**
 * Iterates through a list of custom models and decrypts their API keys for in-memory use.
 */
export declare function decryptModels(models: ModelWithKey[] | null): ModelWithKey[];
export {};
//# sourceMappingURL=cryptoStore.d.ts.map