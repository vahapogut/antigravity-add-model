import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { broadcastState, checkForUpdates, getUpdaterState } from './updater';
import log from 'electron-log/main';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extensionAuthorities } from './customScheme';
import { updateTrayAgentCount } from './tray';
import { StorageManager } from './storage';
import { getIdeInstallPath } from './ideInstall/constants';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoStore = require('./cryptoStore');

/**
 * Registers all IPC handlers for the main process.
 */
export function registerIpcHandlers(storageManager: StorageManager): void {
  // Dialog
  ipcMain.handle('dialog:open-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open workspace',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return undefined;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('dialog:open-workspaces', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: 'Open workspaces',
    });
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
  });

  // Auto-updater
  ipcMain.handle('updater:get-state', () => getUpdaterState());
  ipcMain.handle('updater:apply', async () => {
    broadcastState({ type: 'ready' });
  });
  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged) {
      console.log('[AutoUpdater] Skipping quitAndInstall (requires a packaged app).');
      return;
    }
    autoUpdater.quitAndInstall();
  });

  // Notifications
  ipcMain.handle(
    'notification:send',
    (_event, options: { title: string; body: string; silent?: boolean; payload?: unknown }) => {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: options.silent ?? false,
      });
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) {
            win.restore();
          }
          win.show();
          win.focus();
          if (options.payload) {
            win.webContents.send('notification:clicked', options.payload);
          }
        }
      });
      notification.show();
    },
  );

  // Note: copied from our desktop AGY implementation:
  // vs/platform/nativeNotification/electron-main/electronNotificationService.ts
  ipcMain.handle('notification:open-system-preferences', async () => {
    if (process.platform === 'darwin') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
    } else if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:notifications');
    } else if (process.platform === 'linux') {
      const { exec } = await import('child_process');
      const commands = [
        'gnome-control-center notifications',
        'systemsettings kcm_notifications',
        'xfce4-notifyd-config',
        'gnome-control-center',
        'systemsettings',
      ];
      for (const command of commands) {
        try {
          exec(command);
          return; // If one command executes without immediate error, assume success for now
        } catch {
          // Try next
        }
      }
    }
  });

  // Storage
  ipcMain.handle('storage:get-items', async () => {
    return storageManager.getItems();
  });
  ipcMain.handle('storage:update-items', async (_event, changes: Record<string, string | null>) => {
    await storageManager.updateItems(changes);
  });
  ipcMain.handle('storage:get-custom-models', async () => {
    const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
    const filePath = path.join(geminiDir, 'custom_models.json');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as { models?: CustomModelFileEntry[] };
      const models = parsed.models || [];

      // Return models with masked API keys to the UI
      return models.map((m) => {
        let maskedKey: string = m.apiKey;
        if (m.apiKey && m.apiKey !== 'none') {
          const decrypted = cryptoStore.decryptString(m.apiKey) as string;
          if (decrypted.length <= 8) {
            maskedKey = '********';
          } else {
            maskedKey = decrypted.substring(0, 4) + '...' + decrypted.substring(decrypted.length - 4);
          }
        }
        return {
          ...m,
          apiKey: maskedKey,
        };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle('storage:save-custom-model', async (_event, newModel: CustomModelFileEntry & { apiKey?: string }) => {
    const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
    const filePath = path.join(geminiDir, 'custom_models.json');
    try {
      let models: CustomModelFileEntry[] = [];
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as { models?: CustomModelFileEntry[] };
        models = parsed.models || [];
      } catch {
        // Ignore if file doesn't exist
      }

      // Check if model already exists, if so update it, otherwise push
      const existingIdx = models.findIndex((m) => m.name === newModel.name);

      // Edit collision protection: If new key is masked and old record exists, preserve old encrypted key
      const isMasked =
        newModel.apiKey &&
        (newModel.apiKey.includes('...') || newModel.apiKey.startsWith('***') || newModel.apiKey === '********');
      if (isMasked && existingIdx !== -1) {
        newModel.apiKey = models[existingIdx].apiKey;
        newModel.encrypted = models[existingIdx].encrypted;
      } else {
        if (newModel.apiKey && newModel.apiKey !== 'none') {
          newModel.apiKey = cryptoStore.encryptString(newModel.apiKey);
          newModel.encrypted = true;
        }
      }

      if (existingIdx !== -1) {
        models[existingIdx] = newModel;
      } else {
        models.push(newModel);
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ models }, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      console.error('[IPC] Failed to save custom model:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('storage:delete-custom-model', async (_event, modelName: string) => {
    const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
    const filePath = path.join(geminiDir, 'custom_models.json');
    try {
      let models: CustomModelFileEntry[] = [];
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as { models?: CustomModelFileEntry[] };
        models = parsed.models || [];
      } catch {
        // Ignore if file doesn't exist
      }

      models = models.filter((m) => m.name !== modelName);

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ models }, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      console.error('[IPC] Failed to delete custom model:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // P3-17: Test model connectivity — sends a lightweight HEAD/GET to the model endpoint
  ipcMain.handle('storage:test-model-connection', async (_event, model: TestModelParams) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('https');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http');

    return new Promise<ConnectionTestResult>((resolve) => {
      try {
        let urlStr = model.apiUrl;
        // Normalize URL for chat API endpoints
        if (model.provider === 'openai' || model.provider === 'custom' || model.provider === 'ollama') {
          if (!urlStr.toLowerCase().includes('/chat/completions') && !urlStr.toLowerCase().includes('/completions')) {
            if (urlStr.endsWith('/v1')) {
              urlStr += '/chat/completions';
            } else if (!urlStr.endsWith('/')) {
              urlStr += '/v1/chat/completions';
            } else {
              urlStr += 'v1/chat/completions';
            }
          }
        }

        const url = new URL(urlStr);
        const client = url.protocol === 'https:' ? https : http;

        interface RequestOptions {
          method: string;
          hostname: string;
          port: number;
          path: string;
          timeout: number;
          rejectUnauthorized: boolean;
          headers?: Record<string, string>;
        }

        const baseOptions = {
          hostname: url.hostname,
          port: parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
          path: url.pathname + url.search,
          timeout: 10000,
          rejectUnauthorized: !model.allowUnauthorized,
        };

        const headers: Record<string, string> = {};

        // Add auth header
        if (model.apiKey && model.apiKey !== 'none') {
          let key = model.apiKey;
          try {
            key = cryptoStore.decryptString(model.apiKey);
          } catch {
            /* key might not be encrypted */
          }

          if (key.startsWith('DECRYPTION_FAILED')) {
            resolve({
              success: false,
              error:
                'Stored API key could not be decrypted on this system — delete the model and re-enter its key',
            });
            return;
          }

          if (model.provider === 'anthropic') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2025-04-01';
          } else if (model.provider === 'google') {
            headers['x-goog-api-key'] = key;
          } else {
            headers['Authorization'] = `Bearer ${key}`;
          }
        }

        // OpenCode Go/Zen rejects requests without a session id (HTTP 400).
        if (/opencode\.ai/i.test(model.apiUrl || '')) {
          headers['x-opencode-session'] =
            'antigravity-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
          headers['User-Agent'] = 'antigravity-add-model/2.0';
        }

        const guidance: Record<number, string> = {
          401: 'Authentication rejected (HTTP 401) — check your API key and provider configuration',
          403: 'Access denied (HTTP 403) — check provider permissions, account eligibility, and location availability',
          404: 'Endpoint not found (HTTP 404) — check the API URL and provider model/route availability',
          405: 'Endpoint does not support HEAD (HTTP 405) — this connection test cannot verify model access',
          429: 'Rate limited (HTTP 429) — check provider quota and retry later',
        };

        const utf8ByteLength = (value: string): number => {
          let bytes = 0;
          for (const ch of value) {
            const cp = ch.codePointAt(0)!;
            bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
          }
          return bytes;
        };

        const probe = (method: string, body?: string) =>
          new Promise<{ status?: number; error?: string }>((done) => {
            const opts: RequestOptions = {
              ...baseOptions,
              method,
              headers:
                body === undefined
                  ? headers
                  : {
                      ...headers,
                      'Content-Type': 'application/json',
                      'Content-Length': String(utf8ByteLength(body)),
                    },
            };
            const req = client.request(
              opts,
              (res: { statusCode?: number; resume: () => void }) => {
                done({ status: res.statusCode });
                res.resume(); // consume response to free memory
              },
            );

            req.setTimeout(10000, () => {
              req.destroy();
              done({ error: 'Connection timed out after 10 seconds' });
            });

            req.on('error', (err: NodeJS.ErrnoException) => {
              let message = err.message;
              if (message.includes('ECONNREFUSED')) {
                message = 'Connection refused — server may not be running';
              } else if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
                message = 'Host not found — check the API URL';
              } else if (message.includes('CERT') || message.includes('certificate') || message.includes('SSL')) {
                message = 'SSL/TLS error — try enabling "allowUnauthorized" for self-signed certs';
              }
              done({ error: message });
            });

            req.end(body);
          });

        const isOpenAiCompatible =
          model.provider === 'openai' ||
          model.provider === 'custom' ||
          model.provider === 'ollama' ||
          model.provider === 'openrouter';

        void (async () => {
          const head = await probe('HEAD');
          if (head.status !== undefined && head.status >= 200 && head.status < 400) {
            resolve({
              success: true,
              status: head.status,
              message: `Endpoint reachable (HTTP ${head.status})`,
            });
            return;
          }

          // Many chat/completions routes answer HEAD with 404/405, which makes the
          // probe a false negative. Retry with a minimal POST so the request
          // actually reaches the generation route and can verify auth/routing.
          if (isOpenAiCompatible && (head.status === 404 || head.status === 405)) {
            const body = JSON.stringify({
              model: model.externalModelName || 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            });
            const post = await probe('POST', body);
            const s = post.status;
            // 2xx: real answer. 400/422: the API itself rejected the request, so
            // authentication and routing are working. Other codes are meaningful.
            if (s !== undefined && ((s >= 200 && s < 400) || s === 400 || s === 422)) {
              resolve({
                success: true,
                status: s,
                message: `Endpoint reachable (HTTP ${s} — auth/routing OK)`,
              });
              return;
            }
            if (s !== undefined && guidance[s]) {
              resolve({ success: false, status: s, error: guidance[s] });
              return;
            }
            if (post.error) {
              resolve({ success: false, error: post.error });
              return;
            }
            resolve({ success: false, status: s, error: `Server returned HTTP ${s}` });
            return;
          }

          if (head.error) {
            resolve({ success: false, error: head.error });
            return;
          }
          const st = head.status;
          resolve({
            success: false,
            status: st,
            error: (st !== undefined && guidance[st]) || `Server returned HTTP ${st}`,
          });
        })();
      } catch (err) {
        resolve({ success: false, error: `Invalid URL: ${(err as Error).message}` });
      }
    });
  });

  // Logs
  ipcMain.handle('logs:electron', async () => {
    try {
      const logPath = log.transports.file.getFile().path;
      const contents = await fs.readFile(logPath, 'utf-8');
      return contents;
    } catch (err) {
      return `Failed to read logs: ${String(err)}`;
    }
  });

  // Sidecar extension custom scheme
  ipcMain.handle('extensions:send-authorities', async (_event, authorities: Record<string, string>) => {
    extensionAuthorities.clear();
    for (const [key, value] of Object.entries(authorities)) {
      extensionAuthorities.set(key, value);
    }
  });

  // Agent
  ipcMain.handle('agent:update-active-count', async (_event, count: number) => {
    updateTrayAgentCount(count);
  });

  // Window
  ipcMain.handle('window:set-title-bar-overlay', async (_event, options: { color: string; symbolColor: string }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win && process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: options.color,
        symbolColor: options.symbolColor,
        height: 30,
      });
    }
  });
  ipcMain.handle('window:minimize', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.minimize();
    }
  });
  ipcMain.handle('window:maximize', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.maximize();
    }
  });
  ipcMain.handle('window:unmaximize', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.unmaximize();
    }
  });
  ipcMain.handle('window:is-maximized', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    return win ? win.isMaximized() : false;
  });
  ipcMain.handle('window:close', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.close();
    }
  });
  ipcMain.handle('window:toggle-devtools', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.toggleDevTools();
    }
  });

  // Auto-updater manual check
  ipcMain.handle('updater:check-for-updates', () => {
    checkForUpdates(true);
  });

  // Safe external shell launch
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      await shell.openExternal(url);
    }
  });
  ipcMain.handle('shell:reveal-in-file-picker', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      throw new Error('Expected an absolute filesystem path');
    }
    // Do not send URLs or nonexistent paths to a platform shell.
    await fs.stat(filePath);
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('ide:is-installed', async () => {
    try {
      const installation = await fs.stat(getIdeInstallPath());
      return installation.isDirectory();
    } catch {
      return false;
    }
  });
}

// ─── Local Types ──────────────────────────────────────────────────────────────

interface CustomModelFileEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  [key: string]: unknown;
}

interface TestModelParams {
  apiUrl: string;
  provider: string;
  apiKey?: string;
  allowUnauthorized?: boolean;
  externalModelName?: string;
}

interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message?: string;
  error?: string;
}
