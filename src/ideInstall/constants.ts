/**
 * IDE Install — Constants, platform helpers, and condition checks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log/main';
import { IDE_NEW_DATA_DIR, IDE_OLD_DATA_DIR } from '../paths';
import { StorageManager } from '../storage';

// ─── Constants ──────────────────────────────────────────────────────────────

export const WIZARD_SHOWN_KEY = 'ide-install-wizard-shown';

/** Fetches the latest stable IDE download URL for a given platform. */
export async function fetchIdeDownloadUrl(platformKey: string): Promise<string> {
  const url = `https://antigravity-ide-auto-updater-974169037036.us-central1.run.app/api/update/${platformKey}/stable/latest`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch IDE download URL: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    throw new Error(`No download URL found in the auto-updater response for platform: ${platformKey}`);
  }
  return data.url;
}

// ─── Platform Helpers ──────────────────────────────────────────────────────

export function getPlatformKey(): string {
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'darwin';
  }
  let suffix = '';
  if (process.platform === 'win32') {
    suffix = '-user';
  }
  return `${process.platform}-${process.arch}${suffix}`;
}

/** Returns the expected installation path for the IDE. */
export function getIdeInstallPath(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Antigravity IDE.app';
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Programs',
        'Antigravity IDE',
      );
    case 'linux':
      return path.join(os.homedir(), '.local', 'share', 'antigravity-ide');
    default:
      return path.join(os.homedir(), 'antigravity-ide');
  }
}

// ─── Condition Checks ──────────────────────────────────────────────────────

/**
 * Determines whether the IDE install wizard should be shown.
 *
 * Conditions (all must be true):
 * 1. Wizard has not been shown before (checked via storage)
 * 2. `~/.gemini/antigravity-ide` does NOT exist
 * 3. `~/.gemini/antigravity` DOES exist
 */
export async function shouldShowIdeInstallWizard(storageManager: StorageManager): Promise<boolean> {
  // 1. Already shown?
  const items = await storageManager.getItems();
  if (items[WIZARD_SHOWN_KEY] === 'true') {
    log.info('[IDE Wizard] Already shown, skipping.');
    return false;
  }
  // 1a. If not shown before, then now mark it as shown.
  await storageManager.updateItems({ [WIZARD_SHOWN_KEY]: 'true' });
  // 2. IDE already installed separately?
  if (fs.existsSync(IDE_NEW_DATA_DIR)) {
    log.info(`[IDE Wizard] ${IDE_NEW_DATA_DIR} exists — IDE already installed, skipping.`);
    return false;
  }
  // 3. Old IDE data present (user was migrated)?
  if (!fs.existsSync(IDE_OLD_DATA_DIR)) {
    log.info(`[IDE Wizard] ${IDE_OLD_DATA_DIR} not found — user was not migrated, skipping.`);
    return false;
  }
  log.info('[IDE Wizard] All conditions met — will show wizard.');
  return true;
}
