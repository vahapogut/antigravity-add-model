import { app } from 'electron';
import path from 'path';
import os from 'os';
import { LS_LOG_FILE_NAME } from './constants';

export function getAppDataDirName(): string {
  return `antigravity${app.isPackaged ? '' : '-dev'}`;
}

export function getAppDataDir(): string {
  return path.join(os.homedir(), '.gemini', getAppDataDirName());
}

export function getSettingsPbPath(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'config.json');
}

/**
 * Returns the path to the persistent app storage file.
 * This is used to back a lightweight key-value store for UI state,
 * and is not used for e.g. settings or other "core" app state.
 */
export function getAppStoragePath(): string {
  return path.join(app.getPath('userData'), 'app_storage.json');
}

/**
 * Returns the path to the file used to communicate AGY Hub's remote debugging port.
 * Used by recording encoder.
 */
export function getActivePortFilePath(): string {
  return path.join(app.getPath('userData'), 'DevToolsActivePort');
}

export function getLsLogPath(): string {
  return path.join(app.getPath('logs'), LS_LOG_FILE_NAME);
}

/** User data dir for the old IDE (source for copy). */
export const IDE_OLD_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
/** User data dir for the separately installed IDE (destination for copy). */
export const IDE_NEW_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-ide');
/** User data dir for backup (destination for backup copy). */
export const IDE_BACKUP_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-backup');
