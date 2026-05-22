/**
 * Creates a backup of the specified file with a .bak extension.
 */
export declare function backupFile(filePath: string): void;
/**
 * Checks if Electron's safeStorage API is fully functional on the current system.
 */
export declare function isEncryptionAvailable(): boolean;
/**
 * Encrypts a plaintext string. Falls back to base64 with a prefix if safeStorage is unavailable.
 */
export declare function encryptString(plainText: string): string;
/**
 * Decrypts a previously encrypted string. Handles safeStorage, base64 fallback, and plaintext gracefully.
 */
export declare function decryptString(encryptedText: string): string;
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