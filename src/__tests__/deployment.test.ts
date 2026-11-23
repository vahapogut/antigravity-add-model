import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as asar from '@electron/asar';
import { deploy, fingerprint, parseArgs, preflight, REQUIRED_BUILD_FILES } from '../../scripts/deploy.mjs';

// Real ASAR packing can exceed the default 5 seconds on a busy Windows disk.
// Allow it to finish before cleanup removes files still being packed.
vi.setConfig({ testTimeout: 20000 });

const roots: string[] = [];
const installer = fileURLToPath(new URL('../../scripts/deploy.mjs', import.meta.url));
const endpoint = 'https://daily-cloudcode-pa.googleapis.com';
const patchedEndpoint = 'http://localhost:50999/v1internal/xxxxxxx';

function put(filename: string, contents: string | Buffer) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function readArchive(resources: string, filename: string) {
  const archive = path.join(resources, 'app.asar');
  asar.uncache(archive);
  return asar.extractFile(archive, path.normalize(filename)).toString();
}

function state(resources: string) {
  return JSON.parse(fs.readFileSync(path.join(resources, '.antigravity-model-patch', 'state.json'), 'utf8'));
}

async function installVendor(
  root: string,
  resources: string,
  version = '2.0.1',
  main = 'dist/main.js',
  unpackDir = 'native',
  spreadDefaults = false,
) {
  const source = fs.mkdtempSync(path.join(root, 'vendor-'));
  put(path.join(source, 'package.json'), JSON.stringify({ version, main, vendorField: 'retain me' }));
  put(
    path.join(source, main),
    `// original ${version}\nconst electron_1 = require('electron');\nelectron_1.app.whenReady().then(async () => { /* vendor boot */ });\n`,
  );
  put(
    path.join(source, 'dist/preload.js'),
    `// original preload\nconst electron_1 = require('electron');\nelectron_1.contextBridge.exposeInMainWorld('wsl', { getState: () => electron_1.ipcRenderer.invoke('wsl:get-state') });\n`,
  );
  if (spreadDefaults) {
    put(
      path.join(source, 'dist/languageServer.js'),
      `const child_process_1 = require('child_process');\nconst electron_1 = require('electron');\nconst paths_1 = require('./paths');\nconst wsl_1 = require('./wsl');\nconst lsDefaults_1 = require('./lsDefaults');\nasync function startLanguageServer(port, csrf, options = {}) {\n const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;\n return new Promise((resolve) => {\n const args = [\n ...(0, lsDefaults_1.baseLsArgs)({\n ideVersion: electron_1.app.getVersion(),\n httpsServerPort: port,\n csrfToken: csrf,\n appDataDir: (0, paths_1.getAppDataDirName)(),\n }),\n '--enable_sidecars',\n ];\n if (hostBridgeUrl && hostBridgeToken) args.push(\`--host_bridge_url=\${hostBridgeUrl}\`, \`--host_bridge_token=\${hostBridgeToken}\`);\n if (headless) args.push('--headless');\n let spawnCmd = 'vendor-language-server';\n let spawnArgs = args;\n if (wsl) {\n args.push('--exit_on_stdin_close');\n spawnArgs = (0, wsl_1.wslShellArgs)(wsl.distro, 'exec "$@"', args);\n }\n (0, child_process_1.spawn)(spawnCmd, spawnArgs, {});\n resolve({ wsl });\n });\n}\n`,
    );
    put(
      path.join(source, 'dist/lsDefaults.js'),
      `Object.defineProperty(exports, '__esModule', { value: true });\nexports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;\nexports.baseLsArgs = baseLsArgs;\nexports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';\nexports.LS_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';\nfunction baseLsArgs(opts) {\n return [\n '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',\n '--override_ide_version', opts.ideVersion, '--override_user_agent_name', 'antigravity',\n '--https_server_port', String(opts.httpsServerPort), '--csrf_token', opts.csrfToken,\n '--app_data_dir', opts.appDataDir, '--api_server_url', exports.LS_API_SERVER_URL,\n '--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT,\n ];\n}\n`,
    );
    put(
      path.join(source, 'dist/remote/remoteLsArgs.js'),
      `// original remote SSH defaults\nconst lsDefaults_1 = require('../lsDefaults');\nexports.buildRemoteLsArgs = (opts) => [...lsDefaults_1.baseLsArgs(opts), '--persistent_mode'];\n`,
    );
  } else {
    put(
      path.join(source, 'dist/languageServer.js'),
      `// original server\nfunction startLanguageServer(port, csrf, options = {}) {\n const { headless, wsl } = options;\n return new Promise((resolve, reject) => {\n const args = ['--https_server_port', String(port), '--api_server_url', 'https://generativelanguage.googleapis.com', '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--enable_sidecars'];\n resolve({ port, args });\n });\n}\n`,
    );
  }
  put(path.join(source, 'dist/ipcHandlers.js'), '// vendor WSL and IPC handlers\n');
  put(path.join(source, 'dist/utils.js'), '// vendor window and certificate settings\n');
  put(path.join(source, 'dist/vendor-only.js'), `// vendor ${version}\n`);
  put(path.join(source, 'native/helper.dat'), `native ${version}`);
  put(path.join(source, 'node_modules/vendor/index.js'), '// vendor dependency\n');
  fs.mkdirSync(resources, { recursive: true });
  const unpacked = path.join(resources, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) fs.rmSync(unpacked, { recursive: true });
  await asar.createPackageWithOptions(source, path.join(resources, 'app.asar'), { unpackDir });
  put(path.join(unpacked, 'unlisted-vendor.dat'), `unlisted ${version}`);
  asar.uncache(path.join(resources, 'app.asar'));
}

async function fixture(options: { binary?: string; main?: string; spreadDefaults?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-deployment-test-'));
  roots.push(root);
  const resources = path.join(root, 'App With Spaces', 'resources');
  const dist = path.join(root, 'build');
  for (const file of REQUIRED_BUILD_FILES) put(path.join(dist, file), `// patch ${file}\n`);
  await installVendor(root, resources, '2.0.1', options.main, 'native', options.spreadDefaults);
  if (options.binary)
    put(path.join(resources, 'bin/language_server.exe'), Buffer.from(`MZ\0\x01vendor ${options.binary}\0suffix`));
  return { root, resources, dist };
}

afterEach(() => {
  asar.uncacheAll();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^antigravity-deployment-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('standalone deployment with real ASAR fixtures', () => {
  it('includes every relative runtime dependency in the deployed addon', () => {
    const packaged = new Set(REQUIRED_BUILD_FILES);
    for (const file of REQUIRED_BUILD_FILES) {
      const filename = path.resolve('dist', file);
      expect(fs.existsSync(filename), `Run npm run build: ${file}`).toBe(true);
      const contents = fs.readFileSync(filename, 'utf8');
      for (const match of contents.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
        let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        if (!dependency.endsWith('.js')) dependency += '.js';
        expect(packaged.has(dependency), `${file} requires missing addon module ${dependency}`).toBe(true);
      }
    }
  });
  it('checks a recognized install without writing anything', async () => {
    const f = await fixture();
    const before = fingerprint(f.resources);
    const result = await deploy({ ...f, check: true });
    expect(result.action).toBe('check');
    expect(fingerprint(f.resources)).toEqual(before);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it('adds hooks while preserving current vendor APIs, dependencies, and every unpacked file', async () => {
    const f = await fixture();
    put(path.join(f.dist, 'desktop.js.map'), '{"sources":["desktop.ts"]}');
    put(path.join(f.dist, 'unrelated-debug-file.js'), '// must not be shipped');
    const original = fingerprint(f.resources);
    await deploy(f);
    expect(readArchive(f.resources, 'dist/main.js')).toContain('// original 2.0.1');
    expect(readArchive(f.resources, 'dist/main.js')).toContain('modelPatch/desktop');
    expect(readArchive(f.resources, 'dist/preload.js')).toContain("exposeInMainWorld('wsl'");
    expect(readArchive(f.resources, 'dist/ipcHandlers.js')).toBe('// vendor WSL and IPC handlers\n');
    expect(readArchive(f.resources, 'dist/utils.js')).toBe('// vendor window and certificate settings\n');
    expect(readArchive(f.resources, 'dist/modelPatch/desktop.js')).toBe('// patch desktop.js\n');
    const installedFiles = asar.listPackage(path.join(f.resources, 'app.asar'));
    expect(
      installedFiles.some((file) => file.replace(/\\/g, '/').startsWith('/dist/modelPatch/') && file.endsWith('.map')),
    ).toBe(false);
    expect(installedFiles.some((file) => file.endsWith('unrelated-debug-file.js'))).toBe(false);
    expect(readArchive(f.resources, 'dist/vendor-only.js')).toBe('// vendor 2.0.1\n');
    expect(readArchive(f.resources, 'node_modules/vendor/index.js')).toBe('// vendor dependency\n');
    expect(JSON.parse(readArchive(f.resources, 'package.json')).vendorField).toBe('retain me');
    expect(asar.statFile(path.join(f.resources, 'app.asar'), path.normalize('native/helper.dat')).unpacked).toBe(true);
    const packageBytes = readArchive(f.resources, 'package.json');
    expect(asar.statFile(path.join(f.resources, 'app.asar'), 'package.json').integrity.hash).toBe(
      createHash('sha256').update(packageBytes).digest('hex'),
    );
    expect(fs.readFileSync(path.join(f.resources, 'app.asar.unpacked/native/helper.dat'), 'utf8')).toBe('native 2.0.1');
    expect(fs.readFileSync(path.join(f.resources, 'app.asar.unpacked/unlisted-vendor.dat'), 'utf8')).toBe(
      'unlisted 2.0.1',
    );
    expect(state(f.resources).original).toEqual(original);
  });

  it('patches local 2.32 startup without changing shared defaults or remote SSH args', async () => {
    const f = await fixture({ spreadDefaults: true });
    const original = fingerprint(f.resources);
    const languageServer = readArchive(f.resources, 'dist/languageServer.js');
    const defaults = readArchive(f.resources, 'dist/lsDefaults.js');
    const remote = readArchive(f.resources, 'dist/remote/remoteLsArgs.js');
    await deploy(f);
    expect(readArchive(f.resources, 'dist/languageServer.js')).toContain("require('./modelPatch/proxy')");
    expect(readArchive(f.resources, 'dist/languageServer.js')).toContain("args.push('--inference_api_server_url'");
    expect(readArchive(f.resources, 'dist/lsDefaults.js')).toBe(defaults);
    expect(readArchive(f.resources, 'dist/remote/remoteLsArgs.js')).toBe(remote);
    await deploy({ resources: f.resources, restore: true });
    expect(fingerprint(f.resources)).toEqual(original);
    expect(readArchive(f.resources, 'dist/languageServer.js')).toBe(languageServer);
  });

  it('keeps new runtime files unpacked when their original ancestor directory was unpacked', async () => {
    const f = await fixture();
    await installVendor(f.root, f.resources, '2.0.1', 'dist/main.js', '{native,dist}');
    await deploy(f);
    const archive = path.join(f.resources, 'app.asar');
    const helper = path.normalize('dist/modelPatch/proxy/listen.js');
    expect(asar.statFile(archive, helper).unpacked).toBe(true);
    expect(fs.readFileSync(path.join(`${archive}.unpacked`, helper), 'utf8')).toBe('// patch proxy/listen.js\n');
    expect(readArchive(f.resources, 'dist/main.js')).toContain('// original 2.0.1');
  });

  it('rejects an absolute unpacked link before it can write through to live files', async () => {
    const f = await fixture();
    const unpacked = path.join(f.resources, 'app.asar.unpacked');
    const original = fs.readFileSync(path.join(f.resources, 'app.asar'));
    const sentinel = fs.readFileSync(path.join(unpacked, 'native/helper.dat'));
    fs.symlinkSync(path.join(unpacked, 'native'), path.join(unpacked, 'unsafe-link'), 'junction');
    await expect(deploy(f)).rejects.toThrow('UNSAFE_PATH');
    expect(fs.readFileSync(path.join(f.resources, 'app.asar'))).toEqual(original);
    expect(fs.readFileSync(path.join(unpacked, 'native/helper.dat'))).toEqual(sentinel);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves relative unpacked symlinks without an EEXIST pack failure',
    async () => {
      const f = await fixture();
      const source = path.join(f.root, 'with-links');
      asar.extractAll(path.join(f.resources, 'app.asar'), source);
      fs.symlinkSync('helper.dat', path.join(source, 'native/link'));
      await asar.createPackageWithOptions(source, path.join(f.resources, 'app.asar'), { unpackDir: 'native' });
      asar.uncache(path.join(f.resources, 'app.asar'));
      const original = fingerprint(f.resources);
      await deploy(f);
      expect(fs.readlinkSync(path.join(f.resources, 'app.asar.unpacked/native/link'))).toBe('helper.dat');
      await deploy({ resources: f.resources, restore: true });
      expect(fingerprint(f.resources)).toEqual(original);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts an aliased parent path while rejecting unpacked links that escape it',
    async () => {
      const f = await fixture();
      const aliasedApp = path.join(f.root, 'aliased-app');
      fs.symlinkSync(path.dirname(f.resources), aliasedApp, 'dir');
      const aliasedResources = path.join(aliasedApp, 'resources');
      const link = path.join(f.resources, 'app.asar.unpacked/native/link');
      fs.symlinkSync('helper.dat', link);
      expect(fingerprint(aliasedResources)).toEqual(fingerprint(fs.realpathSync(f.resources)));

      const archiveBefore = fs.readFileSync(path.join(f.resources, 'app.asar'));
      put(path.join(f.resources, 'outside.dat'), 'outside the unpacked tree');
      fs.unlinkSync(link);
      fs.symlinkSync('../../outside.dat', link);
      expect(() => fingerprint(aliasedResources)).toThrow('UNSAFE_PATH');
      await expect(deploy({ ...f, resources: aliasedResources })).rejects.toThrow('UNSAFE_PATH');
      expect(fs.readFileSync(path.join(f.resources, 'app.asar'))).toEqual(archiveBefore);
      expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
    },
  );

  it('ignores a stale legacy backup and creates a fresh restore point for an app upgrade', async () => {
    const f = await fixture();
    fs.copyFileSync(path.join(f.resources, 'app.asar'), path.join(f.resources, 'app.asar.backup'));
    await deploy(f);
    const first = state(f.resources);
    await installVendor(f.root, f.resources, '2.0.2');
    const upgraded = fingerprint(f.resources);
    await deploy(f);
    const second = state(f.resources);
    expect(second.version).toBe('2.0.2');
    expect(second.original).toEqual(upgraded);
    expect(second.backupId).not.toBe(first.backupId);
    expect(readArchive(f.resources, 'dist/vendor-only.js')).toContain('2.0.2');
    await deploy({ resources: f.resources, restore: true });
    expect(fingerprint(f.resources)).toEqual(upgraded);
    expect(JSON.parse(readArchive(f.resources, 'package.json')).version).toBe('2.0.2');
  });

  it('repeated patches retain the pristine restore point, then restore exact original bytes', async () => {
    const f = await fixture({ binary: endpoint });
    const original = fingerprint(f.resources);
    await deploy(f);
    const first = state(f.resources);
    put(path.join(f.dist, 'desktop.js'), '// second patch\n');
    await deploy(f);
    expect(state(f.resources).backupId).toBe(first.backupId);
    expect(state(f.resources).original).toEqual(original);
    expect(readArchive(f.resources, 'dist/modelPatch/desktop.js')).toBe('// second patch\n');
    expect(readArchive(f.resources, 'dist/main.js').match(/modelPatch\/desktop/g)).toHaveLength(1);
    await deploy({ resources: f.resources, restore: true });
    expect(fingerprint(f.resources)).toEqual(original);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch/state.json'))).toBe(false);
  });

  it('recovers the vendor runtime when upgrading a recorded legacy overlay installation', async () => {
    const f = await fixture();
    const original = fingerprint(f.resources);
    await deploy(f);
    const manifest = state(f.resources);
    // Model the previous installer's recorded overlay: the current main/preload
    // are stale, but the verified original archive still belongs to this version.
    const oldOverlay = path.join(f.root, 'old-overlay');
    asar.extractAll(path.join(f.resources, 'app.asar'), oldOverlay);
    put(path.join(oldOverlay, 'dist/main.js'), '// obsolete desktop entry\n');
    put(path.join(oldOverlay, 'dist/preload.js'), '// obsolete renderer bridge\n');
    await asar.createPackageWithOptions(oldOverlay, path.join(f.resources, 'app.asar'), { unpackDir: 'native' });
    asar.uncacheAll();
    put(
      path.join(f.resources, '.antigravity-model-patch/state.json'),
      JSON.stringify({
        ...manifest,
        patched: fingerprint(f.resources),
      }),
    );
    await deploy(f);
    expect(readArchive(f.resources, 'dist/main.js')).toContain('// original 2.0.1');
    expect(readArchive(f.resources, 'dist/preload.js')).toContain("exposeInMainWorld('wsl'");
    expect(state(f.resources).backupId).toBe(manifest.backupId);
    await deploy({ resources: f.resources, restore: true });
    expect(fingerprint(f.resources)).toEqual(original);
  });

  it('refuses an unfamiliar runtime during preflight without creating state or changing bytes', async () => {
    const f = await fixture();
    const unknown = path.join(f.root, 'unknown-runtime');
    asar.extractAll(path.join(f.resources, 'app.asar'), unknown);
    put(path.join(unknown, 'dist/languageServer.js'), '// new upstream startup architecture\n');
    await asar.createPackageWithOptions(unknown, path.join(f.resources, 'app.asar'), { unpackDir: 'native' });
    asar.uncacheAll();
    const before = fingerprint(f.resources);
    await expect(deploy({ ...f, check: true })).rejects.toThrow('UNSUPPORTED_RUNTIME');
    await expect(deploy(f)).rejects.toThrow('UNSUPPORTED_RUNTIME');
    expect(fingerprint(f.resources)).toEqual(before);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it('a failed pack leaves archive, unpacked files, and binary byte-identical', async () => {
    const f = await fixture({ binary: endpoint });
    const original = fingerprint(f.resources);
    await expect(
      deploy(
        { ...f, patchLanguageServer: true },
        {
          pack: async (_source, candidate) => {
            put(candidate, 'incomplete pack');
            throw new Error('simulated pack failure');
          },
        },
      ),
    ).rejects.toThrow('simulated pack failure');
    expect(fingerprint(f.resources)).toEqual(original);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch/state.json'))).toBe(false);
    expect(fs.readdirSync(f.resources).some((item) => item.startsWith('.antigravity-patch-'))).toBe(false);
  });

  it('rolls back both archive and unpacked files when the unpacked swap fails', async () => {
    const f = await fixture();
    const original = fingerprint(f.resources);
    await expect(
      deploy(f, {
        rename: (source, destination) => {
          if (source.includes('candidate') && destination.endsWith('app.asar.unpacked'))
            throw new Error('simulated unpacked rename failure');
          fs.renameSync(source, destination);
        },
      }),
    ).rejects.toThrow('simulated unpacked rename failure');
    expect(fingerprint(f.resources)).toEqual(original);
  });

  it('rolls back archive, unpacked files, binary and old manifest if the final state swap fails', async () => {
    const f = await fixture({ binary: endpoint });
    await deploy(f);
    const before = fingerprint(f.resources);
    const oldState = state(f.resources);
    await expect(
      deploy(
        { ...f, patchLanguageServer: true },
        {
          rename: (source, destination) => {
            if (source.endsWith('state.json') && destination.endsWith('state.json'))
              throw new Error('simulated state rename failure');
            fs.renameSync(source, destination);
          },
        },
      ),
    ).rejects.toThrow('simulated state rename failure');
    expect(fingerprint(f.resources)).toEqual(before);
    expect(state(f.resources)).toEqual(oldState);
  });

  it('refuses restore after an upstream update instead of downgrading it', async () => {
    const f = await fixture();
    await deploy(f);
    await installVendor(f.root, f.resources, '2.1.0');
    const upgraded = fingerprint(f.resources);
    await expect(deploy({ resources: f.resources, restore: true })).rejects.toThrow('RESTORE_REFUSED');
    expect(fingerprint(f.resources)).toEqual(upgraded);
  });

  it('refuses restore when only the language-server binary was upgraded', async () => {
    const f = await fixture({ binary: endpoint });
    await deploy(f);
    put(path.join(f.resources, 'bin/language_server.exe'), 'new upstream binary');
    const updated = fingerprint(f.resources);
    await expect(deploy({ resources: f.resources, restore: true })).rejects.toThrow('RESTORE_REFUSED');
    expect(fingerprint(f.resources)).toEqual(updated);
  });

  it('rejects a corrupted original backup before swapping anything', async () => {
    const f = await fixture();
    const result = await deploy(f);
    const patched = fingerprint(f.resources);
    put(path.join(result.backup, 'app.asar'), 'corrupted backup');
    await expect(deploy({ resources: f.resources, restore: true })).rejects.toThrow('BACKUP_INVALID');
    expect(fingerprint(f.resources)).toEqual(patched);
  });

  it('rejects a manifest containing a path traversal backup id', async () => {
    const f = await fixture();
    await deploy(f);
    const patched = fingerprint(f.resources);
    put(
      path.join(f.resources, '.antigravity-model-patch/state.json'),
      JSON.stringify({ ...state(f.resources), backupId: '../../outside' }),
    );
    await expect(deploy({ resources: f.resources, restore: true })).rejects.toThrow('INVALID_STATE');
    expect(fingerprint(f.resources)).toEqual(patched);
  });

  it('supports a resource directory, install root, and macOS .app root', async () => {
    const f = await fixture();
    expect(preflight({ ...f, resources: path.dirname(f.resources) }).resources).toBe(fs.realpathSync(f.resources));
    const app = path.join(f.root, 'Antigravity.app');
    const macResources = path.join(app, 'Contents/Resources');
    await installVendor(f.root, macResources);
    expect(preflight({ ...f, resources: app }).resources).toBe(fs.realpathSync(macResources));
  });

  it('warns that patching a macOS .app in place breaks its signature and names the clone command', async () => {
    const f = await fixture();
    const app = path.join(f.root, 'Antigravity.app');
    await installVendor(f.root, path.join(app, 'Contents/Resources'));
    const result = spawnSync(process.execPath, [installer, '--resources', app], { encoding: 'utf8' });
    expect(result.stderr).toContain('invalidates its code signature');
    expect(result.stderr).toContain('npm run mac:clone');
  });

  it('leaves an unpacked macOS IDE untouched and the real CLI reports a nonzero exit', async () => {
    const f = await fixture();
    const app = path.join(f.root, 'Antigravity IDE.app');
    const resources = path.join(app, 'Contents/Resources');
    put(path.join(resources, 'app/out/main.js'), '// IDE entry');
    const result = spawnSync(process.execPath, [installer, '--resources', app, '--check'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOT_SUPPORTED');
    expect(result.stderr).toContain('https://github.com/vahapogut/antigravity-add-model/issues/2');
    expect(fs.readFileSync(path.join(resources, 'app/out/main.js'), 'utf8')).toBe('// IDE entry');
    expect(fs.readdirSync(resources)).toEqual(['app']);
  });

  it('rejects an IDE packaged in app.asar before writing backup or state', async () => {
    const f = await fixture({ main: 'out/main.js' });
    const original = fingerprint(f.resources);
    await expect(deploy(f)).rejects.toThrow('NOT_SUPPORTED');
    expect(fingerprint(f.resources)).toEqual(original);
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it('reports missing app and missing compiled build before creating state', async () => {
    const f = await fixture();
    await expect(deploy({ resources: path.join(f.root, 'absent'), dist: f.dist })).rejects.toThrow('APP_NOT_FOUND');
    await expect(deploy({ ...f, dist: path.join(f.root, 'no-build') })).rejects.toThrow('BUILD_MISSING');
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it.each(['proxy/listen.js', 'customIpc.js', 'customPreload.js', 'desktop.js'])(
    'rejects an incomplete build missing %s',
    async (filename) => {
      const f = await fixture();
      fs.unlinkSync(path.join(f.dist, filename));
      await expect(deploy(f)).rejects.toThrow('BUILD_MISSING');
      expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
    },
  );
});

describe('optional fixed-port Windows language-server patch', () => {
  it('patches equal-length bytes transactionally, records fixed port, and restores original binary', async () => {
    const f = await fixture({ binary: `${endpoint}\0${endpoint}` });
    const original = fingerprint(f.resources);
    const binary = path.join(f.resources, 'bin/language_server.exe');
    const originalBytes = fs.readFileSync(binary);
    await deploy({ ...f, patchLanguageServer: true });
    expect(fs.readFileSync(binary).length).toBe(originalBytes.length);
    expect(fs.readFileSync(binary).includes(Buffer.from(endpoint))).toBe(false);
    expect(fs.readFileSync(binary).includes(Buffer.from(patchedEndpoint))).toBe(true);
    expect(JSON.parse(readArchive(f.resources, 'antigravity-proxy.json'))).toEqual({ requiredPort: 50999 });
    const first = state(f.resources);
    await deploy(f);
    expect(state(f.resources).backupId).toBe(first.backupId);
    expect(JSON.parse(readArchive(f.resources, 'antigravity-proxy.json'))).toEqual({ requiredPort: 50999 });
    await deploy({ resources: f.resources, restore: true });
    expect(fingerprint(f.resources)).toEqual(original);
  });

  it('honors an already-patched legacy endpoint without rewriting the binary', async () => {
    const f = await fixture({ binary: patchedEndpoint });
    const before = fs.readFileSync(path.join(f.resources, 'bin/language_server.exe'));
    await deploy(f);
    expect(fs.readFileSync(path.join(f.resources, 'bin/language_server.exe'))).toEqual(before);
    expect(JSON.parse(readArchive(f.resources, 'antigravity-proxy.json'))).toEqual({ requiredPort: 50999 });
  });

  it('does not patch a pristine binary unless explicitly requested', async () => {
    const f = await fixture({ binary: endpoint });
    const before = fs.readFileSync(path.join(f.resources, 'bin/language_server.exe'));
    await deploy(f);
    expect(fs.readFileSync(path.join(f.resources, 'bin/language_server.exe'))).toEqual(before);
    expect(asar.listPackage(path.join(f.resources, 'app.asar'))).not.toContain('/antigravity-proxy.json');
  });

  it('refuses unknown or absent binaries when the option is requested', async () => {
    const f = await fixture({ binary: 'unrecognized endpoint' });
    const original = fingerprint(f.resources);
    await expect(deploy({ ...f, patchLanguageServer: true })).rejects.toThrow('BINARY_NOT_SUPPORTED');
    expect(fingerprint(f.resources)).toEqual(original);
    fs.unlinkSync(path.join(f.resources, 'bin/language_server.exe'));
    await expect(deploy({ ...f, patchLanguageServer: true })).rejects.toThrow('BINARY_NOT_FOUND');
    expect(fs.existsSync(path.join(f.resources, '.antigravity-model-patch'))).toBe(false);
  });

  it('parses explicit options and rejects contradictory or incomplete arguments', () => {
    expect(parseArgs(['--resources', 'App With Spaces', '--check', '--patch-language-server'])).toEqual({
      resources: 'App With Spaces',
      check: true,
      patchLanguageServer: true,
    });
    expect(() => parseArgs(['--resources'])).toThrow('USAGE');
    expect(() => parseArgs(['--check', '--restore'])).toThrow('USAGE');
    expect(() => parseArgs(['--restore', '--patch-language-server'])).toThrow('USAGE');
    expect(() => parseArgs(['--unknown'])).toThrow('USAGE');
  });
});
