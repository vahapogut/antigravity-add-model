import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'path';
import { spawn } from 'child_process';

export enum MenuUpdateStep {
  CheckForUpdates = 'Check for Updates',
  CheckingForUpdates = 'Checking for Updates...',
  DownloadingUpdate = 'Downloading Update...',
  RestartToUpdate = 'Restart to Update',
}

export const updateActions: Record<string, (() => void) | undefined> = {
  [MenuUpdateStep.CheckForUpdates]: () => checkForUpdates(true),
  [MenuUpdateStep.CheckingForUpdates]: undefined,
  [MenuUpdateStep.DownloadingUpdate]: undefined,
  [MenuUpdateStep.RestartToUpdate]: () => quitAndInstall(),
};

// True if the last call to check for updates was from a user click in the menu.
let isManualCheck = false;
// How long to wait after app start before first update check (ms)
const INITIAL_CHECK_DELAY_MS = 10000; // 10 seconds
// How often to re-check for updates after the initial check (ms)
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface UpdaterState {
  type: string;
  update?: { version: string };
}

/** Broadcast a state change to every open BrowserWindow. */
export function broadcastState(state: UpdaterState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:state-changed', state);
  }
}

/**
 * Updates the state of the menu item based on the current step of the updater.
 */
function updateMenuState(step: MenuUpdateStep): void {
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const item = menu.getMenuItemById('check-for-updates');
    if (item) {
      item.label = step;
      item.enabled = updateActions[step] !== undefined;
    }
  }
}

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
export function initAutoUpdater(isHeadless: boolean): void {
  // In dev mode (npm start), electron-updater skips checks because the app
  // isn't packaged. Force it to use the dev config file instead.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = path.join(app.getAppPath(), 'dev-app-update.yml');
  }
  // Set the channel based on architecture and OS.
  // On Windows, we need to explicitly append '-win' to match the artifact name.
  // On macOS and linux, Electron automatically appends the OS to the channel name.
  if (process.platform === 'win32') {
    autoUpdater.channel = `latest-${process.arch}-win`;
  } else {
    autoUpdater.channel = `latest-${process.arch}`;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = app.isPackaged;
  // Auto-updater event handlers → broadcast to renderer
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update…');
    broadcastState({ type: 'checking for updates' });
    updateMenuState(MenuUpdateStep.CheckingForUpdates);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[AutoUpdater] Update available: ${info.version}`);
    broadcastState({
      type: 'available for download',
      update: { version: info.version },
    });
    updateMenuState(MenuUpdateStep.DownloadingUpdate);
    isManualCheck = false;
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log(`[AutoUpdater] Up to date (${info.version})`);
    broadcastState({ type: 'idle' });
    updateMenuState(MenuUpdateStep.CheckForUpdates);
    if (isManualCheck && !isHeadless) {
      const win = BrowserWindow.getFocusedWindow();
      const options = {
        type: 'info' as const,
        title: 'Check for Updates',
        message: 'No updates available',
        buttons: ['OK'],
      };
      if (win) {
        dialog.showMessageBox(win, options);
      } else {
        dialog.showMessageBox(options);
      }
    }
    isManualCheck = false;
  });
  autoUpdater.on('download-progress', () => {
    broadcastState({ type: 'downloading' });
    updateMenuState(MenuUpdateStep.DownloadingUpdate);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
    if (isHeadless) {
      // Proceed to auto install in headless mode
      if (app.isPackaged) {
        if (process.platform === 'linux') {
          const downloadedFilePath = info.downloadedFile;
          headlessQuitAndInstall(downloadedFilePath);
        } else {
          autoUpdater.quitAndInstall();
        }
      } else {
        console.log('[AutoUpdater] Headless mode: Skipping quitAndInstall (not packaged).');
      }
      return;
    }
    broadcastState({
      type: 'ready',
      update: { version: info.version },
    });
    updateMenuState(MenuUpdateStep.RestartToUpdate);
  });
  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message);
    broadcastState({ type: 'idle' });
    updateMenuState(MenuUpdateStep.CheckForUpdates);
    isManualCheck = false;
  });
  // Schedule periodic checks
  setTimeout(() => {
    checkForUpdates();
    setInterval(checkForUpdates, CHECK_INTERVAL_MS);
  }, INITIAL_CHECK_DELAY_MS);
}

export function checkForUpdates(isManual = false): void {
  isManualCheck = isManual;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[AutoUpdater] Failed to check for updates:', err.message);
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

/**
 * Electron native quitAndInstall doesn't relaunch the app with command line arguments.
 * This function waits for the app process to quit, manually replaces the executable with
 * the downloaded update, and then relaunches it with the right headless flags.
 */
function headlessQuitAndInstall(downloadedFilePath: string): void {
  console.log('[AutoUpdater] Headless mode: Scheduling post-quit restart.');
  try {
    const currentPid = process.pid;
    const appPath = process.env.APPIMAGE || process.execPath;
    const args = ['--ozone-platform=headless', '--headless', '--disable-gpu', '--no-sandbox'];
    let script = '';
    if (downloadedFilePath) {
      console.log(`[AutoUpdater] Will manually replace ${appPath} with ${downloadedFilePath}`);
      script = `
        while kill -0 ${currentPid} 2>/dev/null; do sleep 0.5; done
        cp -f "${downloadedFilePath}" "${appPath}"
        chmod +x "${appPath}"
        "${appPath}" ${args.join(' ')}
      `;
    } else {
      console.warn('[AutoUpdater] No downloaded file path found, relaunching without update.');
      script = `
        while kill -0 ${currentPid} 2>/dev/null; do sleep 0.5; done
        sleep 3
        "${appPath}" ${args.join(' ')}
      `;
    }
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'headless' },
    });
    child.unref();
  } catch (e) {
    console.error('[AutoUpdater] Failed to schedule restart:', e);
  }
  app.quit();
}
