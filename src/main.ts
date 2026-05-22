import { app, BrowserWindow, dialog, ipcMain, session, Menu } from 'electron';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipcHandlers';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { createWindow, showQuitConfirmation, setShowQuitConfirmation, showOrCreateWindow } from './utils';
import {
  startAndMonitorLanguageServer,
  getLsPort,
  killLanguageServer,
  getLsCL,
  LS_BINARY,
  setupLocalCertTrust,
  getLsProcess,
} from './languageServer';
import { initAutoUpdater } from './updater';
import { WINDOW_ORIGIN, DYNAMIC_PORT } from './constants';
import { createTray } from './tray';
import { StorageManager } from './storage';
import { getAppStoragePath, getLsLogPath } from './paths';
import { setupApplicationMenu } from './menu';
import { registerCustomSchemes, registerCustomSchemeHandlers } from './customScheme';
import { DEFAULTS, SettingsService, SettingKey } from './services/settingsService';
import { maybeShowIdeInstallWizard } from './ideInstall';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// ─── State ─────────────────────────────────────────────────────────────────

let storageManager: StorageManager;
let settingsService: SettingsService;
let hasStartedMainApplication = false;
let isQuitting = false;

// ─── Config ────────────────────────────────────────────────────────────────

// Driven by ELECTRON_OZONE_PLATFORM_HINT=headless env var.
// This single env var both prevents GTK from crashing (Electron 33+)
// and tells our code to skip createWindow().
const HEADLESS = process.env.ELECTRON_OZONE_PLATFORM_HINT === 'headless';

// When set, skip LS startup and load this URL directly (for dev iteration).
const DEV_URL = process.env.DEV_URL;

if (HEADLESS) {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
}

if (!app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}

// ─── Application Lifecycle ─────────────────────────────────────────────────

let pendingDeepLink: string | null = null;

function handleDeepLink(url: string): void {
  const wins = BrowserWindow.getAllWindows();
  // This block handles deep links when windows are already open.
  if (wins.length > 0) {
    if (wins[0].isMinimized()) {
      wins[0].restore();
    }
    wins[0].show();
    wins[0].focus();
    app.focus({ steal: true });
    wins[0].webContents.send('deep-link', url);
  } else {
    pendingDeepLink = url;
  }
}

app.on('second-instance', (_event, commandLine: string[]) => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    if (wins[0].isMinimized()) {
      wins[0].restore();
    }
    wins[0].show();
    wins[0].focus();
    app.focus({ steal: true });
  }
  const url = commandLine.find((arg) => arg.startsWith('antigravity://'));
  if (url) {
    handleDeepLink(url);
  }
});

registerCustomSchemes();

// Register as default protocol client for deep linking
const PROTOCOL = 'antigravity';
if (!app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

/**
 * App entry point. Runs once Electron has finished initializing.
 * Validates the LS binary, frees the port if needed, spawns the LS,
 * and opens the initial browser window.
 */
app
  .whenReady()
  .then(async () => {
    // Initialize electron-log and override console
    log.initialize();
    Object.assign(console, log.functions);

    const storagePath = getAppStoragePath();
    storageManager = new StorageManager(storagePath, DEFAULTS);
    settingsService = new SettingsService(storageManager);

    // Handle deep link URL from command line arguments (All platforms)
    const deepLinkFromArg = process.argv.find((arg) => arg.startsWith('antigravity://'));
    if (deepLinkFromArg) {
      console.log('Launched with deep link:', deepLinkFromArg);
      pendingDeepLink = deepLinkFromArg;
    }

    // Register IPC handlers
    registerIpcHandlers(storageManager);
    ipcMain.handle('deep-link:get-stored', () => {
      const link = pendingDeepLink;
      pendingDeepLink = null; // Clear after read
      return link;
    });

    // Handle requests coming from custom schemes
    registerCustomSchemeHandlers();

    // Intercept and block SetCloudCodeURL requests to prevent the frontend
    // from overriding the local proxy endpoint
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.includes('SetCloudCodeURL')) {
        console.log(`[Proxy Intercept] Blocked SetCloudCodeURL: ${details.url}`);
        callback({ cancel: true });
        return;
      }
      if (details.url.includes('CloudCode') || details.url.includes('LanguageServerService')) {
        console.log(`[Proxy Intercept] Request URL: ${details.url}`);
      }
      callback({});
    });

    // Set About panel options with LS CL
    const cl = await getLsCL();
    app.setAboutPanelOptions({
      applicationName: 'Antigravity',
      applicationVersion: app.getVersion(),
      version: cl || undefined,
    });

    // Pre-onboarding: check if we should offer to re-install the IDE.
    // This runs before the LS starts so we can show a standalone wizard.
    if (!HEADLESS) {
      await maybeShowIdeInstallWizard(storageManager);
    }

    if (DEV_URL) {
      console.log('Starting in dev mode with URL:', DEV_URL);
      createWindow(DEV_URL);
      hasStartedMainApplication = true;
      return;
    }

    if (!fs.existsSync(LS_BINARY)) {
      const msg = `language_server binary not found at:\n${LS_BINARY}\n\nPlease build/set a valid location.`;
      if (HEADLESS) {
        console.error('ERROR:', msg);
      } else {
        await dialog.showErrorBox('Binary not found', msg);
      }
      app.quit();
      return;
    }

    const csrf = crypto.randomUUID();
    console.log(`Starting app (v${app.getVersion()}) with dynamic port…`);

    let handle: { port: number };
    const targetPort = Number(process.env.JETSKI_LS_PORT) || DYNAMIC_PORT;
    try {
      handle = await startAndMonitorLanguageServer(targetPort, csrf, {
        headless: HEADLESS,
        onPortChanged: (newPort: number) => {
          const newUrl = `${WINDOW_ORIGIN}:${newPort}/`;
          console.log(`[Auto-Restart] Port changed! Reloading all windows with URL: ${newUrl}`);
          // Apply cert trust
          setupLocalCertTrust();
          if (!HEADLESS) {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
              void win.loadURL(newUrl);
            }
          }
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (HEADLESS) {
        console.error('Startup failed:', msg);
      } else {
        await dialog.showErrorBox('Startup failed', msg);
      }
      app.quit();
      return;
    }

    const url = `${WINDOW_ORIGIN}:${handle.port}/`;
    console.log('\n' + '='.repeat(60));
    console.log(`  Local:       ${url}`);
    console.log(`  LS Logs:     ${getLsLogPath()}`);
    console.log(`  Electron Logs: ${log.transports.file.getFile().path}`);
    console.log('='.repeat(60) + '\n');

    if (HEADLESS) {
      // In headless mode, forward stdin to the Language Server to allow interaction via terminal.
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.on('line', (line) => {
        const lsProc = getLsProcess();
        if (lsProc && lsProc.stdin) {
          lsProc.stdin.write(line + '\n');
          console.log('-> Forwarded input to Language Server.');
        } else {
          console.log('Language Server process is not running.');
        }
      });
    }

    // Initial window — opened once after the LS has successfully started.
    if (!HEADLESS) {
      setupApplicationMenu(url);
      createWindow(url);
      if (app.dock) {
        const dockMenu = Menu.buildFromTemplate([
          {
            label: 'New Window',
            click: () => createWindow(url),
          },
        ]);
        app.dock.setMenu(dockMenu);
      }
      createTray([
        {
          id: 'running-agents',
          label: 'No agents running',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: `Open ${app.getName()}`,
          click: () => showOrCreateWindow(getLsPort()),
        },
        {
          label: 'Quit',
          click: () => {
            // Triggers 'before-quit' to run graceful cleanup without confirmation.
            app.quit();
          },
        },
      ]);
    }

    // Start checking for app updates.
    initAutoUpdater(HEADLESS);
    hasStartedMainApplication = true;
  })
  .catch(() => {
    hasStartedMainApplication = true;
  });

/**
 * Fired when all windows have been closed.
 * On macOS the app (and LS) stay alive so the user can re-open via the tray.
 * On all other platforms, shut down the LS and quit.
 */
app.on('window-all-closed', async () => {
  if (isQuitting) {
    return;
  }
  if (!hasStartedMainApplication) {
    return;
  }
  const runInBackground = await settingsService.getSetting(SettingKey.RUN_IN_BACKGROUND);
  if (!runInBackground) {
    // Triggers 'before-quit' to run graceful cleanup without confirmation.
    app.quit();
  } else {
    app.dock?.hide();
  }
});

/**
 * Fired just before the app quits (e.g. Cmd+Q on macOS, or after
 * window-all-closed on non-macOS). Ensures the LS is terminated even if
 * window-all-closed didn't handle it (e.g. on macOS quit via menu).
 */
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  if (!showQuitConfirmation) {
    event.preventDefault();
    isQuitting = true;
    // Destroy all windows to terminate renderers and release keep-alive sockets
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.destroy();
    }
    // Close all active connections and kill the language server in parallel
    await Promise.all([
      session.defaultSession.closeAllConnections().catch((err: Error) => {
        console.error('Failed to close session connections:', err);
      }),
      killLanguageServer(),
    ]);
    app.quit();
    return;
  }
  // Show a confirmation dialog before quitting
  event.preventDefault();
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Cancel', 'Quit'],
    defaultId: 1,
    cancelId: 0,
    title: 'Confirm Quit',
    message: 'Are you sure you want to quit?',
    detail: 'There may be agents or background tasks running.',
  };
  setShowQuitConfirmation(false);
  if (win) {
    void dialog.showMessageBox(win, options).then((result) => {
      if (result.response === 1) {
        // Quit - this will retrigger 'before-quit'
        app.quit();
      }
    });
  }
});

/**
 * Fired when the app is re-activated (e.g. clicking the dock icon on macOS).
 * Re-opens a window if none are currently open.
 */
app.on('activate', () => {
  // On Mac, re-open a window when the user clicks the dock
  // icon and no windows are open.
  if (!HEADLESS && BrowserWindow.getAllWindows().length === 0) {
    const url = DEV_URL ?? `${WINDOW_ORIGIN}:${getLsPort()}/`;
    createWindow(url);
  }
});
