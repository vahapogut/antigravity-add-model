import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(path.resolve('src/cryptoStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const directories: string[] = [];
function fixture(available = false, failEncryption = false, failDecryption = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-crypto-'));
  directories.push(directory);
  const logs: unknown[][] = [];
  const api = {} as {
    encryptString(value: string): string;
    decryptString(value: string): string;
    protectStoredSecret(value: string): string;
    removePlaintextBackup(filePath: string): boolean;
  };
  const dependencies: Record<string, unknown> = {
    fs,
    path,
    crypto,
    'node:os': os,
    'electron-log': { info: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
    electron: {
      app: { getPath: () => directory },
      safeStorage: {
        isEncryptionAvailable: () => available,
        encryptString: (value: string) => {
          if (failEncryption) throw new Error('sensitive-provider-token');
          return Buffer.from(`os:${value}`);
        },
        decryptString: (value: Buffer) => {
          if (failDecryption) throw new Error('sensitive-provider-token');
          return value.toString().slice(3);
        },
      },
    },
  };
  runInNewContext(source, {
    exports: api,
    require: (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
      return dependencies[id];
    },
    Buffer,
    console: { log() {}, error() {} },
  });
  return { ...api, logs, directory, keyPath: path.join(directory, '.gemini', 'antigravity', '.model-credentials-key') };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agy-crypto-'))
      throw new Error('Invalid fixture path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
describe('credential encryption', () => {
  it('uses randomized authenticated encryption when OS storage is unavailable', () => {
    const codec = fixture();
    const first = codec.encryptString('secret-token');
    const second = codec.encryptString('secret-token');
    expect(first).toMatch(/^local-gcm:/);
    expect(second).not.toBe(first);
    expect(codec.decryptString(first)).toBe('secret-token');
    expect(fs.readFileSync(codec.keyPath)).toHaveLength(32);
    const tampered = Buffer.from(first.slice(10), 'base64');
    tampered[tampered.length - 1] ^= 1;
    expect(codec.decryptString(`local-gcm:${tampered.toString('base64')}`)).toBe('DECRYPTION_FAILED');
  });
  it('fails closed for missing, replaced or truncated encryption data', () => {
    const codec = fixture();
    const encrypted = codec.encryptString('secret');
    fs.writeFileSync(codec.keyPath, crypto.randomBytes(32));
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    fs.unlinkSync(codec.keyPath);
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('local-gcm:AA==')).toBe('DECRYPTION_FAILED');
    expect(codec.decryptString('enc:AA==')).toBe('DECRYPTION_FAILED_STORAGE_UNAVAILABLE');
  });
  it('prefers OS storage and can still read legacy configuration', () => {
    const codec = fixture(true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^enc:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('fallback:c2VjcmV0')).toBe('secret');
    expect(codec.decryptString('plain-old-key')).toBe('plain-old-key');
  });
  it('uses authenticated fallback when OS encryption throws', () => {
    const codec = fixture(true, true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^local-gcm:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
    expect(codec.logs.flat().join(' ')).toContain('safeStorage encryption failed');
    expect(JSON.stringify(codec.logs)).not.toContain('sensitive-provider-token');
  });
  it('reports credential failures through the logger without raw exception details', () => {
    const codec = fixture(true, false, true);
    expect(codec.decryptString('enc:c2VjcmV0')).toBe('DECRYPTION_FAILED');
    expect(codec.logs.flat().join(' ')).toContain('OS-backed credentials could not be decrypted');
    expect(JSON.stringify(codec.logs)).not.toContain('sensitive-provider-token');
  });
  it('re-protects secrets stored in clear or in the retired base64 form', () => {
    const codec = fixture();
    for (const stored of ['plain-old-key', 'fallback:c2VjcmV0']) {
      const upgraded = codec.protectStoredSecret(stored);
      expect(upgraded).toMatch(/^local-gcm:/);
      expect(codec.decryptString(upgraded)).toBe(stored === 'plain-old-key' ? 'plain-old-key' : 'secret');
    }
    const current = codec.encryptString('secret');
    expect(codec.protectStoredSecret(current)).toBe(current);
    expect(codec.protectStoredSecret('enc:AA==')).toBe('enc:AA==');
    expect(codec.protectStoredSecret('none')).toBe('none');
    expect(codec.protectStoredSecret('')).toBe('');
  });
});
describe('leftover configuration backup', () => {
  const write = (codec: ReturnType<typeof fixture>, value: unknown) => {
    const file = path.join(codec.directory, 'custom_models.json');
    fs.writeFileSync(`${file}.bak`, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  it.each([
    ['an API key', { models: [{ name: 'models/a', apiKey: 'plain-old-key' }] }],
    ['a retired base64 key', { models: [{ name: 'models/a', apiKey: 'fallback:c2VjcmV0', encrypted: true }] }],
    ['a header value', { models: [{ name: 'models/a', apiKey: 'none', customHeaders: { 'X-Key': 'plain' } }] }],
    ['an account token', { models: [{ name: 'models/a', googleAccounts: [{ refreshToken: 'plain-refresh' }] }] }],
  ])('removes a backup that still holds %s in readable form', (_name, value) => {
    const codec = fixture();
    const file = write(codec, value);
    expect(codec.removePlaintextBackup(file)).toBe(true);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(JSON.stringify(codec.logs)).not.toMatch(/plain|c2VjcmV0/);
  });
  it('keeps a backup that holds no readable credential, and anything it cannot parse', () => {
    const codec = fixture();
    const protectedKey = codec.encryptString('secret');
    for (const value of [
      {
        models: [
          { name: 'models/a', apiKey: protectedKey, encrypted: true },
          { name: 'models/b', apiKey: 'none' },
        ],
      },
      '{not json',
      { unrelated: true },
    ]) {
      const file = write(codec, value);
      expect(codec.removePlaintextBackup(file)).toBe(false);
      expect(fs.existsSync(`${file}.bak`)).toBe(true);
    }
    expect(codec.removePlaintextBackup(path.join(codec.directory, 'missing.json'))).toBe(false);
  });
});
