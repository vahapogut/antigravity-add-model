import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as asar from '@electron/asar';
import { cloneMacApp } from '../../scripts/macos-clone.mjs';

const roots: string[] = [];
const MACHO = Buffer.from('cffaedfe0000000000000000', 'hex');

async function packArchive(archive: string, marker: string) {
  const source = fs.mkdtempSync(path.join(path.dirname(archive), 'asar-src-'));
  fs.writeFileSync(path.join(source, 'main.js'), `// ${marker}\n`);
  await asar.createPackage(source, archive);
  fs.rmSync(source, { recursive: true });
  asar.uncache(archive);
}

function headerHash(archive: string) {
  asar.uncache(archive);
  return createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A fake "official app": the plist is JSON so the stubbed plist operations work on any platform.
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-clone-test-')));
  roots.push(root);
  const source = path.join(root, 'Official', 'Antigravity.app');
  const resources = path.join(source, 'Contents', 'Resources');
  fs.mkdirSync(path.join(source, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(source, 'Contents', 'MacOS', 'Antigravity'), MACHO, { mode: 0o755 });
  fs.chmodSync(path.join(source, 'Contents', 'MacOS', 'Antigravity'), 0o755);
  fs.writeFileSync(path.join(resources, 'icon.dat'), 'icon');
  await packArchive(path.join(resources, 'app.asar'), 'official');
  fs.writeFileSync(
    path.join(source, 'Contents', 'Info.plist'),
    JSON.stringify({
      CFBundleIdentifier: 'com.example.antigravity',
      CFBundleShortVersionString: '9.9.9',
      ElectronAsarIntegrity: {
        'Resources/app.asar': { algorithm: 'SHA256', hash: headerHash(path.join(resources, 'app.asar')) },
      },
    }),
  );
  return { root, source, target: path.join(root, 'Clones', 'Antigravity (add-model).app') };
}

// Stand-ins for the macOS-only tools. `patch` replaces app.asar, as the real patch does.
const operations = {
  codesign: async () => ({ ok: true, stdout: '', stderr: '' }),
  readPlist: async (file: string) => readJson(file),
  setPlistValue: async (file: string, key: string, value: unknown) =>
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), [key]: value })),
  patch: async (resources: string) => packArchive(path.join(resources, 'app.asar'), 'patched'),
};

function listing(directory: string) {
  const entries: string[] = [];
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      entries.push(
        `${path.relative(directory, file)}:${fs.statSync(file).isFile() ? fs.readFileSync(file).toString('hex') : ''}`,
      );
      if (fs.statSync(file).isDirectory()) visit(file);
    }
  };
  visit(directory);
  return entries;
}

afterEach(() => {
  asar.uncacheAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('macOS clone', () => {
  it('copies the app, gives the copy its own bundle id and the patched archive hash, and leaves the official app unchanged', async () => {
    const f = await fixture();
    const before = listing(f.source);

    const result = await cloneMacApp({ source: f.source, target: f.target }, operations);

    const plist = readJson(path.join(f.target, 'Contents', 'Info.plist'));
    const archive = path.join(f.target, 'Contents', 'Resources', 'app.asar');
    expect(result.target).toBe(f.target);
    expect(plist.CFBundleIdentifier).toBe('com.example.antigravity.addmodel');
    expect(plist.ElectronAsarIntegrity['Resources/app.asar'].hash).toBe(headerHash(archive));
    expect(asar.extractFile(archive, 'main.js').toString()).toContain('patched');
    expect(fs.readFileSync(path.join(f.target, 'Contents', 'Resources', 'icon.dat'), 'utf8')).toBe('icon');
    expect(listing(f.source)).toEqual(before);
    expect(fs.readdirSync(path.dirname(f.target))).toEqual([path.basename(f.target)]);
  });

  it('keeps file modes when a restrictive umask is active', async () => {
    if (process.platform === 'win32') return;
    const f = await fixture();
    const previous = process.umask(0o077);
    try {
      await cloneMacApp({ source: f.source, target: f.target }, operations);
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(path.join(f.target, 'Contents', 'MacOS', 'Antigravity')).mode & 0o777).toBe(0o755);
  });

  it.each(['equal', 'inside', 'symlink'])('refuses a destination that is %s the official app', async (kind) => {
    const f = await fixture();
    const before = listing(f.source);
    let target = f.source;
    if (kind === 'inside') target = path.join(f.source, 'Contents', 'Clone.app');
    if (kind === 'symlink') {
      const link = path.join(f.root, 'link');
      fs.symlinkSync(path.join(f.source, 'Contents'), link, 'junction');
      target = path.join(link, 'Clone.app');
    }

    await expect(cloneMacApp({ source: f.source, target }, operations)).rejects.toMatchObject({
      code: 'UNSAFE_DESTINATION',
    });
    expect(listing(f.source)).toEqual(before);
  });
});
