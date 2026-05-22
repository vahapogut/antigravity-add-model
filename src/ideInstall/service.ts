/**
 * IDE Install Service — Download, extract, copy, and launch logic.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import log from 'electron-log/main';
import { fetchIdeDownloadUrl, getPlatformKey, getIdeInstallPath } from './constants';
import { IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR } from '../paths';

// ─── Download ──────────────────────────────────────────────────────────────

export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
  maxRedirects = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        downloadFile(redirectUrl, destPath, onProgress, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const fileStream = fs.createWriteStream(destPath);
      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100));
        }
      });
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

// ─── Extract ───────────────────────────────────────────────────────────────

export async function extractIde(archivePath: string, installPath: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  if (!fs.existsSync(path.dirname(installPath))) {
    await fsPromises.mkdir(path.dirname(installPath), { recursive: true });
  }

  switch (process.platform) {
    case 'darwin': {
      const tempDir = path.join(os.tmpdir(), 'antigravity-ide-extract');
      if (fs.existsSync(tempDir)) {
        await execFileAsync('rm', ['-rf', tempDir]);
      }
      await fsPromises.mkdir(tempDir, { recursive: true });
      await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', tempDir]);
      const entries = await fsPromises.readdir(tempDir);
      const appBundle = entries.find((e) => e.endsWith('.app'));
      if (!appBundle) {
        throw new Error('No .app bundle found in the downloaded archive');
      }
      if (fs.existsSync(installPath)) {
        await execFileAsync('rm', ['-rf', installPath]);
      }
      await execFileAsync('mv', [path.join(tempDir, appBundle), installPath]);
      if (fs.existsSync(tempDir)) {
        await execFileAsync('rm', ['-rf', tempDir]);
      }
      break;
    }
    case 'linux': {
      if (!fs.existsSync(installPath)) {
        await fsPromises.mkdir(installPath, { recursive: true });
      }
      await execFileAsync('tar', ['-xzf', archivePath, '-C', installPath, '--strip-components=1']);
      break;
    }
    case 'win32': {
      await execFileAsync(archivePath, ['/VERYSILENT', '/MERGETASKS=!runcode']);
      break;
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ─── Copy User Data ────────────────────────────────────────────────────────

export async function copyUserData(sourcePath: string, destPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) {
    log.warn(`[IDE Wizard] Source path does not exist: ${sourcePath}`);
    return;
  }
  await fsPromises.cp(sourcePath, destPath, { recursive: true, force: true });
  log.info(`[IDE Wizard] Copied user data: ${sourcePath} → ${destPath}`);
}

// ─── Download & Install (orchestrator) ─────────────────────────────────────

export async function downloadAndInstallIde(): Promise<void> {
  const platformKey = getPlatformKey();
  const downloadUrl = await fetchIdeDownloadUrl(platformKey);
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'linux' ? '.tar.gz' : '.zip';
  const tempFile = path.join(os.tmpdir(), `antigravity-ide-download${ext}`);
  log.info(`[IDE Wizard] Downloading IDE from ${downloadUrl}…`);
  await downloadFile(downloadUrl, tempFile);
  const installPath = getIdeInstallPath();
  log.info(`[IDE Wizard] Installing IDE to ${installPath}…`);
  await extractIde(tempFile, installPath);
  log.info(`[IDE Wizard] Copying user data…`);
  await copyUserData(IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR);
  try {
    await fsPromises.unlink(tempFile);
  } catch {
    /* ignore */
  }
}
