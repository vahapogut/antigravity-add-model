// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safeStorage, app } = (() => {
  try {
    return require('electron');
  } catch {
    return {};
  }
})();
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as os from 'node:os';
import log from 'electron-log';

let credentialDirectory: string | undefined;
/** Set before reading credentials when running the owned Node proxy service. */
export function configureCredentialDirectory(directory: string): void {
  credentialDirectory = path.resolve(directory);
}

function localKey(create: boolean): Buffer {
  const directory = credentialDirectory || path.join(app?.getPath('home') || os.homedir(), '.gemini', 'antigravity');
  const filename = path.join(directory, '.model-credentials-key');
  if (create && !fs.existsSync(filename)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw new Error('Invalid local credential encryption key');
  return key;
}

function encryptLocal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localKey(true), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return 'local-gcm:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** A stored secret that anyone who can read the file can also read: clear text or the retired base64 form. */
function readable(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== 'none' && !/^(enc:|local-gcm:)/.test(value);
}

/**
 * Earlier releases copied the configuration to "<file>.bak" before encrypting it.
 * Remove that copy while it still holds a readable credential; leave any other file alone.
 */
export function removePlaintextBackup(filePath: string): boolean {
  const backupPath = filePath + '.bak';
  try {
    if (!fs.lstatSync(backupPath).isFile()) return false;
    const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const models: unknown = Array.isArray(parsed) ? parsed : parsed?.models;
    if (!Array.isArray(models)) return false;
    const exposed = models.some(
      (model) =>
        model &&
        typeof model === 'object' &&
        (readable(model.apiKey) ||
          Object.values(model.customHeaders || {}).some(readable) ||
          (Array.isArray(model.googleAccounts) ? model.googleAccounts : []).some(
            (account: Record<string, unknown> | null) =>
              account && [account.accessToken, account.refreshToken, account.clientSecret].some(readable),
          )),
    );
    if (!exposed) return false;
    fs.unlinkSync(backupPath);
    log.info('[CryptoStore] Removed an unencrypted configuration backup left by an earlier release.');
    return true;
  } catch {
    // A missing or unreadable backup is not ours to judge.
    return false;
  }
}

/**
 * Checks if Electron's safeStorage API is fully functional on the current system.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (_e) {
    return false;
  }
}

/**
 * Use OS-backed storage when available; otherwise AES-GCM with a local user key.
 */
export function encryptString(plainText: string): string {
  if (!plainText || plainText === 'none') return plainText;

  if (isEncryptionAvailable()) {
    try {
      const buffer = safeStorage.encryptString(plainText);
      return 'enc:' + buffer.toString('base64');
    } catch {
      log.error('[CryptoStore] safeStorage encryption failed; using local authenticated encryption.');
      return encryptLocal(plainText);
    }
  } else {
    return encryptLocal(plainText);
  }
}

/**
 * Decrypts a previously encrypted string. Handles safeStorage, base64 fallback, and plaintext gracefully.
 */
export function decryptString(encryptedText: string): string {
  if (!encryptedText || encryptedText === 'none') return encryptedText;

  if (encryptedText.startsWith('local-gcm:')) {
    try {
      const bytes = Buffer.from(encryptedText.slice(10), 'base64');
      if (bytes.length < 28) throw new Error('Truncated ciphertext');
      const cipher = createDecipheriv('aes-256-gcm', localKey(false), bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch {
      log.error(
        '[CryptoStore] Local credentials could not be decrypted. Check the credential key or re-enter the key.',
      );
      return 'DECRYPTION_FAILED';
    }
  }

  if (encryptedText.startsWith('enc:')) {
    const base64Data = encryptedText.substring(4);
    if (isEncryptionAvailable()) {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        return safeStorage.decryptString(buffer);
      } catch {
        log.error('[CryptoStore] OS-backed credentials could not be decrypted. Re-enter them in the model manager.');
        return 'DECRYPTION_FAILED';
      }
    } else {
      log.error(
        '[CryptoStore] OS-encrypted credentials are unavailable in this runtime. Re-enter them in its model manager.',
      );
      return 'DECRYPTION_FAILED_STORAGE_UNAVAILABLE';
    }
  } else if (encryptedText.startsWith('fallback:')) {
    const base64Data = encryptedText.substring(9);
    try {
      return Buffer.from(base64Data, 'base64').toString('utf-8');
    } catch {
      log.error('[CryptoStore] Legacy credentials could not be decoded. Re-enter them in the model manager.');
      return 'DECRYPTION_FAILED';
    }
  }

  // Plaintext (older config, not yet migrated)
  return encryptedText;
}

/** Re-protect a stored secret kept in clear or in the retired base64 form; other values are returned unchanged. */
export function protectStoredSecret(value: string): string {
  if (!readable(value)) return value;
  if (!value.startsWith('fallback:')) return encryptString(value);
  const plain = decryptString(value);
  return plain === 'DECRYPTION_FAILED' ? value : encryptString(plain);
}

interface ModelWithKey {
  apiKey?: string;
  encrypted?: boolean;
  provider?: string;
  [key: string]: unknown;
}

/**
 * Iterates through a list of custom models and encrypts their API keys.
 */
export function encryptModels(models: ModelWithKey[] | null): ModelWithKey[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.apiKey && model.apiKey !== 'none' && !model.encrypted) {
      return {
        ...model,
        apiKey: encryptString(model.apiKey),
        encrypted: true,
      };
    }
    return model;
  });
}

/**
 * Iterates through a list of custom models and decrypts their API keys for in-memory use.
 */
export function decryptModels(models: ModelWithKey[] | null): ModelWithKey[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.encrypted) {
      return {
        ...model,
        apiKey: decryptString(model.apiKey as string),
        encrypted: false,
      };
    }
    return model;
  });
}
