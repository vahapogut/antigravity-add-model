export declare function getAppDataDirName(): string;
export declare function getAppDataDir(): string;
export declare function getSettingsPbPath(): string;
/**
 * Returns the path to the persistent app storage file.
 * This is used to back a lightweight key-value store for UI state,
 * and is not used for e.g. settings or other "core" app state.
 */
export declare function getAppStoragePath(): string;
/**
 * Returns the path to the file used to communicate AGY Hub's remote debugging port.
 * Used by recording encoder.
 */
export declare function getActivePortFilePath(): string;
export declare function getLsLogPath(): string;
/** User data dir for the old IDE (source for copy). */
export declare const IDE_OLD_DATA_DIR: string;
/** User data dir for the separately installed IDE (destination for copy). */
export declare const IDE_NEW_DATA_DIR: string;
/** User data dir for backup (destination for backup copy). */
export declare const IDE_BACKUP_DATA_DIR: string;
//# sourceMappingURL=paths.d.ts.map