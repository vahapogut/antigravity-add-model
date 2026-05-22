/**
 * IDE Install Wizard — Window orchestration and IPC handlers.
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log/main';
import { shouldShowIdeInstallWizard } from './constants';
import { IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR, IDE_BACKUP_DATA_DIR } from '../paths';
import { copyUserData, downloadAndInstallIde } from './service';
import { getWizardHtml } from './wizardHtml';
import { StorageManager } from '../storage';

/**
 * Shows the IDE install wizard as a modal window.
 * Returns a promise that resolves when the wizard is dismissed.
 */
export function showIdeInstallWizard(): Promise<void> {
  return new Promise((resolve) => {
    const wizardWindow = new BrowserWindow({
      width: 720,
      height: 580,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: '#0D0D0D',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'wizardPreload.js'),
      },
    });

    const iconPath = path.join(__dirname, '..', '..', 'icon.png');
    let iconBase64 = '';
    try {
      if (fs.existsSync(iconPath)) {
        iconBase64 = fs.readFileSync(iconPath).toString('base64');
      } else {
        log.warn(`[IDE Wizard] Icon not found at ${iconPath}`);
      }
    } catch (e) {
      log.error(`[IDE Wizard] Failed to read icon: ${e}`);
    }

    const html = getWizardHtml(iconBase64);
    let isResolved = false;

    const cleanup = () => {
      if (isResolved) {
        return;
      }
      isResolved = true;
      ipcMain.removeHandler('wizard:complete');
      resolve();
    };

    ipcMain.handle('wizard:complete', async (_event, shouldDownload: boolean) => {
      cleanup();
      wizardWindow.close();
      if (shouldDownload) {
        log.info('[IDE Wizard] Background download requested. Starting installation in background...');
        void downloadAndInstallIde().catch((err) => {
          log.error(`[IDE Wizard] Background download/install failed: ${err}`);
        });
      }
    });

    wizardWindow.on('closed', () => {
      cleanup();
    });

    const doSetup = async () => {
      // If the old Antigravity user data directory exists, copy it to the new IDE
      // data dir and to a backup directory.
      if (fs.existsSync(IDE_OLD_DATA_DIR)) {
        if (!fs.existsSync(IDE_NEW_DATA_DIR)) {
          try {
            await copyUserData(IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR);
          } catch (err) {
            log.error(`[IDE Wizard] Failed to copy to new IDE data dir: ${err}`);
          }
        }
        if (!fs.existsSync(IDE_BACKUP_DATA_DIR)) {
          try {
            await copyUserData(IDE_OLD_DATA_DIR, IDE_BACKUP_DATA_DIR);
          } catch (err) {
            log.error(`[IDE Wizard] Failed to copy to backup IDE data dir: ${err}`);
          }
        }
      }
      if (!wizardWindow.isDestroyed()) {
        wizardWindow.webContents.send('wizard:setup-complete');
      }
    };

    wizardWindow.once('ready-to-show', () => {
      wizardWindow.show();
      void doSetup();
    });

    void wizardWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

/**
 * Checks conditions and shows the IDE install wizard if appropriate.
 * This should be called early in the app lifecycle, before the LS starts.
 * Returns true if the wizard was shown, false otherwise.
 */
export async function maybeShowIdeInstallWizard(storageManager: StorageManager): Promise<boolean> {
  const shouldShow = await shouldShowIdeInstallWizard(storageManager);
  if (!shouldShow) {
    return false;
  }
  await showIdeInstallWizard();
  return true;
}
