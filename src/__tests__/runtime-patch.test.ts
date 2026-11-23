import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { planRuntimePatch } from '../../scripts/runtime-patch.mjs';

const vendorMain = `
const electron_1 = require('electron');
const hostBridge = require('./hostBridgeServer');
electron_1.app.whenReady().then(() => hostBridge.start());
`;

const vendorServer = `
exports.startLanguageServer = startLanguageServer;
function startLanguageServer(port, csrf, options = {}) {
  const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;
  return new Promise((resolve) => {
    record('vendor-start');
    const args = ['--standalone', '--https_server_port', String(port), '--csrf_token', csrf,
      '--api_server_url', 'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--enable_sidecars'];
    if (hostBridgeUrl && hostBridgeToken) args.push('--host_bridge_url=' + hostBridgeUrl, '--host_bridge_token=' + hostBridgeToken);
    if (headless) args.push('--headless');
    if (wsl) args.push('--wsl-distro=' + wsl.distro, '--exit_on_stdin_close');
    resolve({ args, wsl });
  });
}
exports.setupLocalCertTrust = () => 'vendor certificate policy';
`;

const vendorSpreadServer = `
const child_process_1 = require('child_process');
const electron_1 = require('electron');
const paths_1 = require('./paths');
const wsl_1 = require('./wsl');
const lsDefaults_1 = require('./lsDefaults');
exports.startLanguageServer = startLanguageServer;
async function startLanguageServer(port, csrf, options = {}) {
  const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;
  return new Promise((resolve) => {
    record('vendor-start');
    const args = [
      ...(0, lsDefaults_1.baseLsArgs)({
        ideVersion: electron_1.app.getVersion(),
        httpsServerPort: port,
        csrfToken: csrf,
        appDataDir: (0, paths_1.getAppDataDirName)(),
      }),
      '--enable_sidecars',
    ];
    if (hostBridgeUrl && hostBridgeToken) {
      args.push(\`--host_bridge_url=\${hostBridgeUrl}\`, \`--host_bridge_token=\${hostBridgeToken}\`);
    }
    if (headless) {
      args.push('--headless');
    }
    let spawnCmd = 'vendor-language-server';
    let spawnArgs = args;
    if (wsl) {
      args.push('--exit_on_stdin_close');
      spawnCmd = 'wsl';
      spawnArgs = (0, wsl_1.wslShellArgs)(wsl.distro, 'exec "$@"', args);
    }
    (0, child_process_1.spawn)(spawnCmd, spawnArgs, {});
    resolve({ wsl });
  });
}
`;

const vendorLsDefaults = `
Object.defineProperty(exports, '__esModule', { value: true });
exports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;
exports.baseLsArgs = baseLsArgs;
exports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';
exports.LS_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
function baseLsArgs(opts) {
  return [
    '--standalone',
    '--override_ide_name',
    'antigravity',
    '--subclient_type',
    'hub',
    '--override_ide_version',
    opts.ideVersion,
    '--override_user_agent_name',
    'antigravity',
    '--https_server_port',
    String(opts.httpsServerPort),
    '--csrf_token',
    opts.csrfToken,
    '--app_data_dir',
    opts.appDataDir,
    '--api_server_url',
    exports.LS_API_SERVER_URL,
    '--cloud_code_endpoint',
    exports.LS_CLOUD_CODE_ENDPOINT,
  ];
}
`;

const vendorPreload = `
const electron_1 = require('electron');
const storageAPI = { getItems: () => electron_1.ipcRenderer.invoke('storage:get-items') };
electron_1.contextBridge.exposeInMainWorld('nativeStorage', storageAPI);
electron_1.contextBridge.exposeInMainWorld('wsl', { getState: () => 'vendor WSL' });
electron_1.contextBridge.exposeInMainWorld('futureBridge', { newMethod: () => 'future vendor API' });
`;

// Deliberately reuse vendor lexical bindings; the appended preload must isolate them.
const customPreload = `
"use strict";
Object.defineProperty(exports, '__esModule', { value: true });
const electron_1 = require('electron');
const storageAPI = { getCustomModels: () => electron_1.ipcRenderer.invoke('models:get-custom-models') };
window.addEventListener('DOMContentLoaded', () => storageAPI.getCustomModels());
`;

function fixture(
  overrides: Record<string, string> = {},
  build = customPreload,
  contextBuild = '// context preload fixture',
) {
  const files: Record<string, string> = {
    'dist/main.js': vendorMain,
    'dist/languageServer.js': vendorServer,
    'dist/lsDefaults.js': vendorLsDefaults,
    'dist/preload.js': vendorPreload,
    ...overrides,
  };
  const readVendor = vi.fn((name: string) => Buffer.from(files[name]));
  const readBuild = vi.fn((name: string) => {
    expect(['customPreload.js', 'contextUsagePreload.js']).toContain(name);
    return Buffer.from(name === 'customPreload.js' ? build : contextBuild);
  });
  const plan = () => planRuntimePatch(readVendor, readBuild) as Map<string, Buffer>;
  return { files, readVendor, readBuild, plan };
}

function serverFixture(source = vendorServer) {
  const patched = fixture({ 'dist/languageServer.js': source }).plan().get('dist/languageServer.js')!.toString();
  const exports: Record<string, (...args: unknown[]) => Promise<{ args: string[]; wsl?: unknown }>> = {};
  const defaultsExports: Record<string, unknown> = {};
  runInNewContext(vendorLsDefaults, { exports: defaultsExports });
  const record = vi.fn();
  const spawn = vi.fn();
  const startProxy = vi.fn().mockResolvedValue(61001);
  runInNewContext(patched, {
    exports,
    record,
    require: (name: string) => {
      if (name === './modelPatch/proxy') return { startProxy };
      if (name === './lsDefaults') return defaultsExports;
      if (name === 'child_process') return { spawn };
      if (name === 'electron') return { app: { getVersion: () => '2.32.1' } };
      if (name === './paths') return { getAppDataDirName: () => 'antigravity' };
      if (name === './wsl') return { wslShellArgs: (_distro: string, _script: string, args: string[]) => args };
      throw new Error(`Unexpected fixture require: ${name}`);
    },
  });
  return { exports, record, spawn, startProxy };
}

describe('vendor runtime adapter', () => {
  it('plans only three vendor edits without evaluating code', () => {
    const f = fixture({ 'dist/main.js': `throw new Error('must not execute');\n${vendorMain}` });
    const patched = f.plan();
    expect([...patched.keys()]).toEqual(['dist/main.js', 'dist/languageServer.js', 'dist/preload.js']);
    expect([...patched.values()].every(Buffer.isBuffer)).toBe(true);
    expect(patched.get('dist/main.js')!.toString()).toContain("throw new Error('must not execute')");
    expect(patched.get('dist/languageServer.js')!.toString()).toContain(
      "exports.setupLocalCertTrust = () => 'vendor certificate policy'",
    );
  });

  it('installs the extension before the vendor ready handler and supplies the current port getter', () => {
    const calls: string[] = [];
    let port = 60111;
    let getPort: () => number;
    runInNewContext(fixture().plan().get('dist/main.js')!.toString(), {
      require: (name: string) =>
        ({
          electron: { app: { whenReady: () => ({ then: () => calls.push('vendor-ready') }) } },
          './hostBridgeServer': {},
          './modelPatch/desktop': {
            install: (getter: () => number) => {
              getPort = getter;
              calls.push('patch-install');
            },
          },
          './languageServer': { getLsPort: () => port },
        })[name],
    });
    expect(calls).toEqual(['patch-install', 'vendor-ready']);
    expect(getPort!()).toBe(60111);
    port = 60222;
    expect(getPort!()).toBe(60222);
  });

  it('awaits the local proxy before startup and retains host-bridge arguments', async () => {
    const f = serverFixture();
    let resolvePort: (port: number) => void;
    f.startProxy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePort = resolve;
        }),
    );
    const pending = f.exports.startLanguageServer(60123, 'csrf', {
      headless: true,
      hostBridgeUrl: 'http://localhost:62000',
      hostBridgeToken: 'bridge-token',
    });
    expect(f.record).not.toHaveBeenCalled();
    resolvePort!(61005);
    const { args } = await pending;
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      expect(args[args.indexOf(flag) + 1]).toBe('http://localhost:61005');
    }
    expect(args).toContain('--host_bridge_url=http://localhost:62000');
    expect(args).toContain('--host_bridge_token=bridge-token');
    expect(args).toContain('--headless');
  });

  it('preserves vendor WSL startup without starting or routing through the host proxy', async () => {
    const f = serverFixture();
    const wsl = { distro: 'Ubuntu', binaryPath: '/opt/vendor/language_server' };
    const result = await f.exports.startLanguageServer(60123, 'csrf', { wsl });
    expect(f.startProxy).not.toHaveBeenCalled();
    expect(result.wsl).toBe(wsl);
    expect(result.args[result.args.indexOf('--api_server_url') + 1]).toBe('https://generativelanguage.googleapis.com');
    expect(result.args[result.args.indexOf('--cloud_code_endpoint') + 1]).toBe(
      'https://daily-cloudcode-pa.googleapis.com',
    );
    expect(result.args).not.toContain('--inference_api_server_url');
    expect(result.args).toContain('--wsl-distro=Ubuntu');
    expect(result.args).toContain('--exit_on_stdin_close');
  });

  it('propagates a proxy startup failure before the language server starts', async () => {
    const f = serverFixture();
    const error = new Error('Port unavailable');
    f.startProxy.mockRejectedValue(error);
    await expect(f.exports.startLanguageServer(0, 'csrf')).rejects.toBe(error);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('updates an existing inference endpoint once, preserving its vendor value in WSL mode', async () => {
    const f = serverFixture(
      vendorServer.replace("'--standalone'", "'--inference_api_server_url', 'https://inference.vendor.example'"),
    );
    const local = await f.exports.startLanguageServer(0, 'csrf');
    expect(local.args.filter((arg) => arg === '--inference_api_server_url')).toHaveLength(1);
    expect(local.args[local.args.indexOf('--inference_api_server_url') + 1]).toBe('http://localhost:61001');
    f.startProxy.mockClear();
    const remote = await f.exports.startLanguageServer(0, 'csrf', { wsl: { distro: 'Ubuntu' } });
    expect(remote.args[remote.args.indexOf('--inference_api_server_url') + 1]).toBe('https://inference.vendor.example');
    expect(f.startProxy).not.toHaveBeenCalled();
  });

  it('retains the legacy standalone headless argument', async () => {
    const source = vendorServer
      .replace('options = {}', 'headless')
      .replace(
        'const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;',
        'const hostBridgeUrl = undefined, hostBridgeToken = undefined, wsl = undefined;',
      );
    const f = serverFixture(source);
    const { args } = await f.exports.startLanguageServer(0, 'csrf', true);
    expect(f.startProxy).toHaveBeenCalledOnce();
    expect(args).toContain('--headless');
    expect(args[args.indexOf('--api_server_url') + 1]).toBe('http://localhost:61001');
  });

  it('routes the 2.32 shared-defaults layout through the proxy only after local args are assembled', async () => {
    const f = serverFixture(vendorSpreadServer);
    await f.exports.startLanguageServer(60123, 'csrf', {
      headless: true,
      hostBridgeUrl: 'http://localhost:62000',
      hostBridgeToken: 'bridge-token',
    });
    expect(f.spawn).toHaveBeenCalledOnce();
    const args = f.spawn.mock.calls[0][1] as string[];
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      expect(args.filter((arg) => arg === flag)).toHaveLength(1);
      expect(args[args.indexOf(flag) + 1]).toBe('http://localhost:61001');
    }
    expect(args.indexOf('--inference_api_server_url')).toBeLessThan(
      args.indexOf('--host_bridge_url=http://localhost:62000'),
    );
    expect(args).toContain('--host_bridge_token=bridge-token');
    expect(args).toContain('--headless');
    expect(f.record).toHaveBeenCalledWith('vendor-start');
  });

  it('preserves 2.32 WSL endpoints without starting the host proxy', async () => {
    const f = serverFixture(vendorSpreadServer);
    const wsl = { distro: 'Ubuntu', binaryPath: '/opt/vendor/language_server' };
    const result = await f.exports.startLanguageServer(60123, 'csrf', { wsl });
    expect(f.startProxy).not.toHaveBeenCalled();
    expect(result.wsl).toBe(wsl);
    const args = f.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--api_server_url') + 1]).toBe('https://generativelanguage.googleapis.com');
    expect(args[args.indexOf('--cloud_code_endpoint') + 1]).toBe('https://daily-cloudcode-pa.googleapis.com');
    expect(args).not.toContain('--inference_api_server_url');
    expect(args).toContain('--exit_on_stdin_close');
  });

  it('propagates proxy failures before the 2.32 language server starts', async () => {
    const f = serverFixture(vendorSpreadServer);
    const error = new Error('Port unavailable');
    f.startProxy.mockRejectedValue(error);
    await expect(f.exports.startLanguageServer(0, 'csrf')).rejects.toBe(error);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('reads shared defaults only for the 2.32 layout and leaves them outside the patch', () => {
    const legacy = fixture();
    legacy.plan();
    expect(legacy.readVendor).not.toHaveBeenCalledWith('dist/lsDefaults.js');
    const spread = fixture({ 'dist/languageServer.js': vendorSpreadServer });
    const patched = spread.plan();
    expect(spread.readVendor).toHaveBeenCalledWith('dist/lsDefaults.js');
    expect([...patched.keys()]).toEqual(['dist/main.js', 'dist/languageServer.js', 'dist/preload.js']);
    expect(patched.has('dist/lsDefaults.js')).toBe(false);
  });

  it('preserves all vendor bridges and appends an isolated sandbox-compatible preload', () => {
    const source = fixture().plan().get('dist/preload.js')!.toString();
    expect(source.startsWith(vendorPreload)).toBe(true);
    const exposed: Record<string, Record<string, () => unknown>> = {};
    const invoke = vi.fn();
    let domReady: () => void;
    runInNewContext(source, {
      require: (name: string) => {
        expect(name).toBe('electron');
        return {
          ipcRenderer: { invoke },
          contextBridge: {
            exposeInMainWorld: (name: string, api: Record<string, () => unknown>) => {
              expect(exposed[name]).toBeUndefined();
              exposed[name] = api;
            },
          },
        };
      },
      window: {
        addEventListener: (_name: string, callback: () => void) => {
          domReady = callback;
        },
      },
    });
    expect(exposed.wsl.getState()).toBe('vendor WSL');
    expect(exposed.futureBridge.newMethod()).toBe('future vendor API');
    exposed.nativeStorage.getItems();
    expect(invoke).toHaveBeenLastCalledWith('storage:get-items');
    domReady!();
    expect(invoke).toHaveBeenLastCalledWith('models:get-custom-models');
  });

  it('loads the context preload in its own scope without replacing vendor APIs', () => {
    const calls: string[] = [];
    const context = `const electron_1 = require('electron'); electron_1.ipcRenderer.invoke('storage:get-chat-context-usage');`;
    const source = fixture({}, customPreload, context).plan().get('dist/preload.js')!.toString();
    const exposed: string[] = [];
    runInNewContext(source, {
      require: () => ({
        ipcRenderer: { invoke: (channel: string) => calls.push(channel) },
        contextBridge: { exposeInMainWorld: (name: string) => exposed.push(name) },
      }),
      window: { addEventListener: () => {} },
    });
    expect(calls).toContain('storage:get-chat-context-usage');
    expect(exposed).toEqual(['nativeStorage', 'wsl', 'futureBridge']);
  });

  it.each([
    "require('node:fs');",
    "require('electron').contextBridge.exposeInMainWorld('nativeStorage', {});",
    "import('./unvalidated.js');",
  ])('rejects unsafe context preload additions: %s', (context) => {
    expect(() => fixture({}, customPreload, context).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });

  it.each([
    ['missing ready hook', 'dist/main.js', "require('electron');"],
    ['duplicate ready hook', 'dist/main.js', vendorMain + '\nelectron_1.app.whenReady();'],
    ['nested ready hook', 'dist/main.js', "const e = require('electron'); (() => e.app.whenReady())();"],
    ['missing startup function', 'dist/languageServer.js', 'exports.start = () => {};'],
    ['duplicate startup function', 'dist/languageServer.js', vendorServer + '\nfunction startLanguageServer() {}'],
    ['unknown startup signature', 'dist/languageServer.js', vendorServer.replace('options = {}', 'config = {}')],
    ['missing endpoint', 'dist/languageServer.js', vendorServer.replace('--api_server_url', '--renamed_url')],
    [
      'duplicate endpoint',
      'dist/languageServer.js',
      vendorServer.replace("'--standalone'", "'--api_server_url', 'https://duplicate.example'"),
    ],
    [
      'later endpoint override',
      'dist/languageServer.js',
      vendorServer.replace(
        'resolve({ args, wsl });',
        "args.push('--api_server_url', 'https://later.example'); resolve({ args, wsl });",
      ),
    ],
    ['spread args', 'dist/languageServer.js', vendorServer.replace("'--standalone'", '...otherArgs')],
    [
      'nonliteral endpoint',
      'dist/languageServer.js',
      vendorServer.replace("'https://generativelanguage.googleapis.com'", 'getEndpoint()'),
    ],
    ['invalid JavaScript', 'dist/preload.js', 'const = ;'],
  ])('fails closed on %s', (_label, name, source) => {
    expect(() => fixture({ [name]: source }).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });

  it.each([
    [
      'unknown shared-defaults callee',
      { 'dist/languageServer.js': vendorSpreadServer.replace('lsDefaults_1.baseLsArgs)', 'lsDefaults_1.otherArgs)') },
    ],
    [
      'wrong shared-defaults import',
      { 'dist/languageServer.js': vendorSpreadServer.replace("require('./lsDefaults')", "require('./otherDefaults')") },
    ],
    [
      'late endpoint override',
      {
        'dist/languageServer.js': vendorSpreadServer.replace(
          'resolve({ wsl });',
          "args.push('--api_server_url', 'https://later.example'); resolve({ wsl });",
        ),
      },
    ],
    [
      'dynamic spread mutation',
      { 'dist/languageServer.js': vendorSpreadServer.replace("args.push('--headless');", 'args.push(...extraArgs);') },
    ],
    [
      'unknown args alias',
      {
        'dist/languageServer.js': vendorSpreadServer.replace(
          'let spawnArgs = args;',
          'const alias = args; let spawnArgs = args;',
        ),
      },
    ],
    [
      'unknown helper signature',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace('function baseLsArgs(opts)', 'function baseLsArgs(opts, extra)'),
      },
    ],
    [
      'duplicate default endpoint',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace(
          "'--standalone',",
          "'--api_server_url', exports.LS_API_SERVER_URL, '--standalone',",
        ),
      },
    ],
    [
      'dynamic default endpoint',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace('exports.LS_API_SERVER_URL,', 'getEndpoint(),'),
      },
    ],
    [
      'inference endpoint in shared defaults',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace(
          "'--standalone',",
          "'--inference_api_server_url', 'https://inference.vendor.example', '--standalone',",
        ),
      },
    ],
    [
      'mismatched WSL options binding',
      { 'dist/languageServer.js': vendorSpreadServer.replace('} = options;', '} = config;') },
    ],
    [
      'mutable WSL options binding',
      {
        'dist/languageServer.js': vendorSpreadServer.replace(
          'const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;',
          'let { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;',
        ),
      },
    ],
    [
      'unguarded WSL argument wrapping',
      { 'dist/languageServer.js': vendorSpreadServer.replace('if (wsl) {', 'if (options.remote) {') },
    ],
    [
      'async helper',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace('function baseLsArgs(opts)', 'async function baseLsArgs(opts)'),
      },
    ],
    [
      'rest-parameter helper',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace('function baseLsArgs(opts)', 'function baseLsArgs(...opts)'),
      },
    ],
    [
      'nested helper export',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': vendorLsDefaults.replace(
          'exports.baseLsArgs = baseLsArgs;',
          'function nestedExport() { exports.baseLsArgs = baseLsArgs; }',
        ),
      },
    ],
    [
      'later dynamic endpoint write',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': `${vendorLsDefaults}\nexports.LS_API_SERVER_URL = getEndpoint();`,
      },
    ],
    [
      'wrong getVersion receiver',
      {
        'dist/languageServer.js': vendorSpreadServer.replace('electron_1.app.getVersion()', 'paths_1.app.getVersion()'),
      },
    ],
    [
      'wrong getAppDataDirName receiver',
      {
        'dist/languageServer.js': vendorSpreadServer.replace('paths_1.getAppDataDirName', 'wsl_1.getAppDataDirName'),
      },
    ],
    [
      'wrong wslShellArgs receiver',
      { 'dist/languageServer.js': vendorSpreadServer.replace('wsl_1.wslShellArgs', 'paths_1.wslShellArgs') },
    ],
    [
      'wrong spawn receiver',
      { 'dist/languageServer.js': vendorSpreadServer.replace('child_process_1.spawn', 'wsl_1.spawn') },
    ],
    [
      'wrong Electron import',
      { 'dist/languageServer.js': vendorSpreadServer.replace("require('electron')", "require('not-electron')") },
    ],
    [
      'computed helper export write',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': `${vendorLsDefaults}\nexports["baseLsArgs"] = () => [];`,
      },
    ],
    [
      'reflective helper export write',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': `${vendorLsDefaults}\nObject.defineProperty(exports, "baseLsArgs", { value: () => [] });`,
      },
    ],
    [
      'computed endpoint write',
      {
        'dist/languageServer.js': vendorSpreadServer,
        'dist/lsDefaults.js': `${vendorLsDefaults}\nexports["LS_API_SERVER_URL"] = "https://later.example";`,
      },
    ],
  ])('fails closed on 2.32 %s', (_label, overrides) => {
    expect(() => fixture(overrides).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });

  it('rejects repeated patching instead of appending another extension', () => {
    const first = fixture().plan();
    const files = Object.fromEntries([...first].map(([name, data]) => [name, data.toString()]));
    expect(() => fixture(files).plan()).toThrow('already patched');
  });

  it.each(['dist/main.js', 'dist/languageServer.js', 'dist/preload.js'])(
    'explains a missing required vendor file: %s',
    (missing) => {
      const f = fixture();
      expect(() =>
        planRuntimePatch((name: string) => {
          if (name === missing) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
          return f.readVendor(name);
        }, f.readBuild),
      ).toThrow(
        new RegExp(`UNSUPPORTED_RUNTIME: ${missing.replaceAll('.', '\\.')}.*cannot read required runtime file`),
      );
    },
  );

  it.each([
    "require('./proxy');",
    "require('./modelPatch/desktop').install();",
    'session.defaultSession.webRequest.onBeforeRequest(() => {});',
    "session.defaultSession.webRequest['onBeforeRequest'](() => {});",
  ])('rejects conflicting or older runtime patches with clean reinstall guidance: %s', (conflict) => {
    expect(() => fixture({ 'dist/main.js': conflict + vendorMain }).plan()).toThrow('UNSUPPORTED_RUNTIME');
    expect(() => fixture({ 'dist/main.js': conflict + vendorMain }).plan()).toThrow('reinstall a clean vendor build');
  });

  it.each([
    "require('./customHelpers');",
    'require(someModule);',
    "require('electron').contextBridge.exposeInMainWorld('nativeStorage', {});",
    "import('./other.js');",
  ])('rejects a custom preload that breaks its isolated sandbox contract: %s', (source) => {
    expect(() => fixture({}, source).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });
});
