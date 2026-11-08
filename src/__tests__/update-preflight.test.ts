import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import * as asar from '@electron/asar';
import { deploy, fingerprint, REQUIRED_BUILD_FILES } from '../../scripts/deploy.mjs';
import { configureIde } from '../../scripts/ide.mjs';
import { classifyUpdateProcesses, inspectUpdateInstallation, listWindowsProcesses, parseUpdateArgs, probeWindowsMutexes, updatePreflight } from '../../scripts/update-preflight.mjs';

vi.setConfig({ testTimeout: 20000 });
const roots: string[] = [];
function put(filename: string, contents: string) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, contents); }
function root() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-update-test-')));
  roots.push(directory); return directory;
}
function ide() {
  const directory = root();
  const resources = path.join(directory, 'Antigravity IDE/resources');
  const app = path.join(resources, 'app');
  put(path.join(app, 'package.json'), JSON.stringify({ main: 'out/main.js', version: '1.107.0' }));
  put(path.join(app, 'product.json'), JSON.stringify({ nameShort: 'Antigravity IDE', applicationName: 'antigravity-ide', ideVersion: '2.5.5', win32MutexName: 'antigravity-fixture' }));
  put(path.join(app, 'out/main.js'), '// unchanged vendor runtime');
  put(path.join(app, 'extensions/antigravity/package.json'), JSON.stringify({ contributes: { configuration: { properties: { 'jetski.cloudCodeUrl': { type: 'string' } } } } }));
  const settings = path.join(directory, 'profile/User/settings.json');
  put(settings, '{\n  "theme": "keep me"\n}\n');
  const executable = path.join(path.dirname(resources), 'Antigravity IDE.exe');
  put(executable, 'fixture executable, never run');
  const dataDirectory = path.join(directory, 'models');
  put(path.join(dataDirectory, 'custom_models.json'), 'saved models and credentials must remain untouched');
  return { root: directory, resources, settings, executable, dataDirectory, platform: 'win32' };
}
async function standalone() {
  const directory = root();
  const source = path.join(directory, 'vendor');
  const resources = path.join(directory, 'Antigravity/resources');
  const dist = path.join(directory, 'build');
  put(path.join(source, 'package.json'), JSON.stringify({ main: 'dist/main.js', version: '2.0.1' }));
  put(path.join(source, 'dist/main.js'), "const electron_1 = require('electron'); electron_1.app.whenReady().then(() => {});\n");
  put(path.join(source, 'dist/preload.js'), "const electron_1 = require('electron'); electron_1.contextBridge.exposeInMainWorld('wsl', { getState: () => electron_1.ipcRenderer.invoke('wsl:get-state') });\n");
  put(path.join(source, 'dist/languageServer.js'), "function startLanguageServer(port, csrf, options = {}) { const { headless, wsl } = options; return new Promise((resolve, reject) => { const args = ['--api_server_url', 'https://generativelanguage.googleapis.com', '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com']; resolve({port,args}); }); }\n");
  for (const file of REQUIRED_BUILD_FILES) put(path.join(dist, file), `// fixture ${file}\n`);
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackage(source, path.join(resources, 'app.asar'));
  const dataDirectory = path.join(directory, 'data');
  put(path.join(dataDirectory, 'custom_models.json'), 'keep credentials');
  return { root: directory, resources, dist, dataDirectory, platform: 'win32' };
}
const quiet = () => ({
  listProcesses: vi.fn(async () => []),
  probeMutexes: vi.fn(async (names: string[]) => names.map(name => ({ name, status: 'absent' }))),
  serviceCommand: vi.fn(async () => ({ status: 'stopped' })),
});

afterEach(() => {
  asar.uncacheAll();
  for (const directory of roots.splice(0)) {
    expect(path.dirname(directory)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^agy-update-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows update recovery', () => {
  it('requires an explicit target and accepts no force/kill options', () => {
    expect(() => parseUpdateArgs(['prepare'])).toThrow('exact installation');
    expect(() => parseUpdateArgs(['prepare', '--resources', '.', '--force'])).toThrow('USAGE');
    expect(() => parseUpdateArgs(['check', '--resources', '--json'])).toThrow('USAGE');
    expect(parseUpdateArgs(['check', '--resources', '.', '--json'])).toMatchObject({ command: 'check', resources: path.resolve('.'), json: true });
    expect(() => inspectUpdateInstallation({})).toThrow('explicit');
  });

  it('checks IDE state without modifying settings, runtime or stopping any service', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings);
    const hooks = quiet();
    const report = await updatePreflight({ ...f, command: 'check' }, hooks);
    expect(report).toMatchObject({ readyForPreparation: true, installation: { kind: 'ide', version: '2.5.5', status: 'managed' }, actions: [] });
    expect(fs.readFileSync(f.settings)).toEqual(before);
    expect(hooks.serviceCommand).not.toHaveBeenCalled();
  });

  it('restores the managed IDE endpoint, preserves user edits/models, then stops the owned proxy', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    fs.writeFileSync(f.settings, fs.readFileSync(f.settings, 'utf8').replace('keep me', 'new theme'));
    const hooks = quiet();
    hooks.serviceCommand.mockImplementation(async () => {
      expect(fs.readFileSync(f.settings, 'utf8')).not.toContain('jetski.cloudCodeUrl');
      return { status: 'stopped' };
    });
    const report = await updatePreflight({ ...f, command: 'prepare' }, hooks);
    expect(report.actions).toEqual([{ action: 'restore', status: 'restored' }, { action: 'proxy', status: 'stopped' }]);
    expect(fs.readFileSync(f.settings, 'utf8')).toContain('new theme');
    expect(fs.readFileSync(path.join(f.dataDirectory, 'custom_models.json'), 'utf8')).toContain('must remain untouched');
    expect(hooks.serviceCommand).toHaveBeenCalledWith({ command: 'stop', dataDirectory: f.dataDirectory });
  });

  it('blocks a running installation and unverified identities without changing settings or killing anything', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings);
    for (const executable of [f.executable, null]) {
      const hooks = quiet();
      hooks.listProcesses.mockResolvedValue([{ pid: 123, name: 'Antigravity IDE.exe', executable }] as never);
      const report = await updatePreflight({ ...f, command: 'check' }, hooks);
      expect(report.readyForPreparation).toBe(false);
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('PREPARE_BLOCKED');
      expect(fs.readFileSync(f.settings)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('uses canonical executable paths and a directory boundary, not names or PID guesses', () => {
    const f = ide();
    const other = path.join(f.root, 'Antigravity IDE-old', 'Antigravity IDE.exe'); put(other, 'other installation');
    const child = path.join(path.dirname(f.resources), 'resources/bin/helper.exe'); put(child, 'child');
    const report = classifyUpdateProcesses(path.dirname(f.resources), [
      { pid: 1, name: 'helper.exe', executable: child },
      { pid: 2, name: 'Antigravity IDE.exe', executable: other },
      { pid: 3, name: 'language_server_windows_x64.exe', executable: null },
      { pid: 4, name: 'unrelated.exe', executable: null },
    ], f);
    expect(report.matching.map((item: { pid: number }) => item.pid)).toEqual([1]);
    expect(report.otherInstallations.map((item: { pid: number }) => item.pid)).toEqual([2]);
    expect(report.unverifiable.map((item: { pid: number }) => item.pid)).toEqual([3]);
    expect(classifyUpdateProcesses(path.dirname(f.resources), [
      { pid: 5, name: 'Antigravity IDE.exe', executable: f.executable.toUpperCase() },
    ], { platform: 'win32', realpath: (value: string) => value }).matching).toHaveLength(1);
  });

  it('reports a second installation as a possible shared updater blocker without restoring either app', async () => {
    const f = ide(); const other = ide(); configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings); const hooks = quiet();
    hooks.listProcesses.mockResolvedValue([{ pid: 456, name: 'Antigravity IDE.exe', executable: other.executable }] as never);
    const report = await updatePreflight({ ...f, command: 'check' }, hooks);
    expect(report.readyForPreparation).toBe(false);
    expect(report.processes.otherInstallations).toHaveLength(1);
    await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('shared updater mutex');
    expect(fs.readFileSync(f.settings)).toEqual(before);
    expect(hooks.serviceCommand).not.toHaveBeenCalled();
  });

  it('fails closed when process inspection is unavailable, including non-Windows prepare', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    const hooks = quiet(); hooks.listProcesses.mockRejectedValue(new Error('CIM unavailable'));
    expect(await updatePreflight({ ...f, command: 'check' }, hooks)).toMatchObject({ readyForPreparation: false, processError: 'CIM unavailable' });
    await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('PREPARE_BLOCKED');
    expect(hooks.serviceCommand).not.toHaveBeenCalled();
    await expect(listWindowsProcesses({ platform: 'linux' })).rejects.toThrow('PROCESS_CHECK_UNAVAILABLE');
  });

  it('requests no process command lines and hides the bounded PowerShell probe', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify([{ ProcessId: 123, Name: 'Antigravity.exe', ExecutablePath: 'C:\\App\\Antigravity.exe' }]) }));
    expect(await listWindowsProcesses({ platform: 'win32', exec: run })).toEqual([{ pid: 123, name: 'Antigravity.exe', executable: 'C:\\App\\Antigravity.exe' }]);
    expect(run.mock.calls[0]?.[1]).toContain('Hidden');
    expect(JSON.stringify(run.mock.calls)).not.toContain('CommandLine');
    expect(run.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 15000 });
  });

  it('derives only the IDE runtime mutex names from validated product metadata', () => {
    const f = ide();
    expect(inspectUpdateInstallation(f).mutexNames).toEqual(['antigravity-fixture', 'antigravity-fixturesetup', 'antigravity-fixture-ready']);
    const filename = path.join(f.resources, 'app/product.json');
    const product = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const value of [undefined, '', "x'; Write-Output secret; '", 'Global\\other', 'a'.repeat(129), 123]) {
      put(filename, JSON.stringify({ ...product, win32MutexName: value }));
      expect(() => inspectUpdateInstallation(f)).toThrow('MUTEX_METADATA_INVALID');
    }
  });

  it('reports IDE/setup/readiness mutex blockers without any matching process or mutation', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings);
    for (const index of [0, 1, 2]) {
      const hooks = quiet();
      hooks.probeMutexes.mockImplementation(async names => names.map((name, i) => ({ name, status: i === index ? 'present' : 'absent' })));
      const report = await updatePreflight({ ...f, command: 'check' }, hooks);
      expect(report).toMatchObject({ readyForPreparation: false, processes: { matching: [] }, mutexes: { status: 'checked' } });
      expect(report.mutexes.items[index].status).toBe('present');
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('installer mutex');
      expect(fs.readFileSync(f.settings)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('fails closed for unavailable, inaccessible and invalid mutex probes', async () => {
    const f = ide(); configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings);
    for (const problem of ['denied', 'failure', 'empty', 'duplicate', 'unknown-status', 'missing-error']) {
      const hooks = quiet();
      hooks.probeMutexes.mockImplementation(async names => {
        if (problem === 'failure') throw new Error('PowerShell unavailable');
        if (problem === 'empty') return [];
        return names.map((name, i) => ({
          name: problem === 'duplicate' ? names[0] : name,
          status: problem === 'unknown-status' ? 'clear' : i === 0 ? 'unverifiable' : 'absent',
          ...(i === 0 && problem !== 'missing-error' ? { errorCode: 5 } : {}),
        }));
      });
      expect((await updatePreflight({ ...f, command: 'check' }, hooks)).readyForPreparation).toBe(false);
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('PREPARE_BLOCKED');
      expect(fs.readFileSync(f.settings)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('rechecks process and mutex state after backup inspection before any write', async () => {
    for (const blocker of ['process', 'mutex', 'probe-failure']) {
      const f = ide(); configureIde({ ...f, action: 'apply' });
      const before = fs.readFileSync(f.settings);
      const hooks = quiet();
      if (blocker === 'process') hooks.listProcesses.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { pid: 123, name: 'Antigravity IDE.exe', executable: f.executable },
      ] as never);
      else if (blocker === 'probe-failure') hooks.probeMutexes.mockImplementationOnce(async names => names.map(name => ({ name, status: 'absent' })))
        .mockRejectedValueOnce(new Error('Probe became unavailable'));
      else hooks.probeMutexes.mockImplementationOnce(async names => names.map(name => ({ name, status: 'absent' })))
        .mockImplementationOnce(async names => names.map((name, i) => ({ name, status: i === 1 ? 'present' : 'absent' })));
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow('PREPARE_BLOCKED');
      expect(hooks.listProcesses).toHaveBeenCalledTimes(2);
      expect(hooks.probeMutexes).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(f.settings)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('opens existing mutexes read-only and validates the complete bounded probe response', async () => {
    const names = ['antigravity-fixture', 'antigravity-fixturesetup', 'antigravity-fixture-ready'];
    const result = names.map((name, i) => ({ name, status: i === 0 ? 'present' : i === 1 ? 'absent' : 'unverifiable', ...(i === 2 ? { errorCode: 5 } : {}) }));
    const run = vi.fn(async () => ({ stdout: JSON.stringify(result) }));
    expect(await probeWindowsMutexes(names, { platform: 'win32', exec: run })).toEqual(result);
    const args = run.mock.calls[0]?.[1] as string[];
    const script = args.at(-1)!;
    expect(script).toContain('OpenMutexW(0x00100000');
    expect(script).toContain('CloseHandle($handle)');
    expect(script).not.toMatch(/CreateMutex|ReleaseMutex|WaitFor|CommandLine|Stop-Process/);
    expect(args).toContain('Hidden');
    // Add-Type compiles C# on every run; a busy runner took longer than 15 s (main CI run 42482353252).
    expect(run.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 60000 });
    for (const value of [[], [{ name: names[0], status: 'absent' }], 'not json']) {
      run.mockResolvedValueOnce({ stdout: typeof value === 'string' ? value : JSON.stringify(value) });
      await expect(probeWindowsMutexes(names, { platform: 'win32', exec: run })).rejects.toThrow('MUTEX_CHECK_UNAVAILABLE');
    }
    await expect(probeWindowsMutexes(["bad'; name"], { platform: 'win32', exec: run })).rejects.toThrow('MUTEX_METADATA_INVALID');
    await expect(probeWindowsMutexes([names[0], names[0]], { platform: 'win32', exec: run })).rejects.toThrow('MUTEX_METADATA_INVALID');
    await expect(probeWindowsMutexes(names, { platform: 'linux', exec: run })).rejects.toThrow('MUTEX_CHECK_UNAVAILABLE');
  });

  // Two real PowerShell probes, each allowed up to 60 s, must fit inside the test timeout.
  it.skipIf(process.platform !== 'win32')('can read absence of a unique Windows mutex without creating it', async () => {
    const name = `antigravity-test-${randomUUID()}`;
    expect(await probeWindowsMutexes([name])).toEqual([{ name, status: 'absent' }]);
    expect(await probeWindowsMutexes([name])).toEqual([{ name, status: 'absent' }]);
  }, 130000);

  it('rejects corrupted IDE backups and external endpoint conflicts before service shutdown', async () => {
    for (const problem of ['backup', 'malformed-backup', 'endpoint']) {
      const f = ide(); configureIde({ ...f, action: 'apply' });
      if (problem === 'backup') fs.writeFileSync(`${f.settings}.antigravity-model-patch/original.jsonc`, '{}');
      else if (problem === 'malformed-backup') {
        fs.writeFileSync(`${f.settings}.antigravity-model-patch/original.jsonc`, '{invalid');
        const stateFile = `${f.settings}.antigravity-model-patch/state.json`;
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        state.originalHash = createHash('sha256').update('{invalid').digest('hex');
        fs.writeFileSync(stateFile, JSON.stringify(state));
      }
      else fs.writeFileSync(f.settings, fs.readFileSync(f.settings, 'utf8').replace('127.0.0.1:50999', '127.0.0.1:50998'));
      const before = fs.readFileSync(f.settings); const hooks = quiet();
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow(problem === 'backup' ? 'BACKUP_INVALID' : problem === 'malformed-backup' ? 'INVALID_SETTINGS' : 'RESTORE_REFUSED');
      expect(fs.readFileSync(f.settings)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('does not invent restoration for an unmanaged target or replace already-restored IDE settings', async () => {
    const f = await standalone(); const before = fingerprint(f.resources); const hooks = quiet();
    const report = await updatePreflight({ ...f, command: 'prepare' }, hooks);
    expect(report.actions).toEqual([{ action: 'proxy', status: 'stopped' }]);
    expect(report.mutexes).toEqual({ status: 'not-applicable', items: [] });
    expect(hooks.probeMutexes).not.toHaveBeenCalled();
    expect(report.guidance).toContain('no application or settings files were restored');
    expect(fingerprint(f.resources)).toEqual(before);
    const i = ide(); configureIde({ ...i, action: 'apply' }); configureIde({ ...i, action: 'restore' });
    const settings = fs.readFileSync(i.settings);
    expect((await updatePreflight({ ...i, command: 'prepare' }, hooks)).actions).toEqual([{ action: 'proxy', status: 'stopped' }]);
    expect(fs.readFileSync(i.settings)).toEqual(settings);
  });

  it('restores only the matching standalone backup and works without compiled addon files', async () => {
    const f = await standalone(); const original = fingerprint(f.resources);
    await deploy(f);
    const before = fingerprint(f.resources);
    const hooks = quiet();
    expect(await updatePreflight({ ...f, dist: path.join(f.root, 'absent'), command: 'check' }, hooks)).toMatchObject({ installation: { kind: 'standalone', status: 'managed' } });
    expect(fingerprint(f.resources)).toEqual(before);
    await updatePreflight({ ...f, dist: path.join(f.root, 'absent'), command: 'prepare' }, hooks);
    expect(fingerprint(f.resources)).toEqual(original);
    expect(fs.readFileSync(path.join(f.dataDirectory, 'custom_models.json'), 'utf8')).toBe('keep credentials');
    expect(inspectUpdateInstallation(f).status).toBe('unmanaged');
  });

  it('refuses a changed installation or corrupted backup before stopping a service', async () => {
    for (const problem of ['installation', 'backup']) {
      const f = await standalone(); await deploy(f);
      const state = JSON.parse(fs.readFileSync(path.join(f.resources, '.antigravity-model-patch/state.json'), 'utf8'));
      const target = problem === 'installation' ? f.resources : path.join(f.resources, '.antigravity-model-patch/backups', state.backupId);
      put(path.join(target, 'bin/language_server.exe'), 'changed');
      const before = fingerprint(f.resources); const hooks = quiet();
      await expect(updatePreflight({ ...f, command: 'prepare' }, hooks)).rejects.toThrow(problem === 'installation' ? 'RESTORE_REFUSED' : 'BACKUP_INVALID');
      expect(fingerprint(f.resources)).toEqual(before);
      expect(hooks.serviceCommand).not.toHaveBeenCalled();
    }
  });

  it('never sends shutdown to a foreign server matching only a stale PID/port', async () => {
    const f = ide(); let stops = 0;
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith('/stop')) stops++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'foreign-service', instance: randomUUID(), pid: process.pid }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      put(path.join(f.dataDirectory, '.ide-proxy/state.json'), JSON.stringify({ version: 1, token: 'a'.repeat(64), instance: randomUUID(), pid: process.pid, port: address.port }));
      await expect(updatePreflight({ ...f, command: 'prepare' }, { ...quiet(), serviceCommand: undefined })).rejects.toThrow('PROXY_STOP_FAILED');
      expect(stops).toBe(0);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
