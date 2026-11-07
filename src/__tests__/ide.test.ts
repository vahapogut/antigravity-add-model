import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureIde, editSetting, inspectIde, launchIde, parseIdeArgs, parseSettings, proxyEndpoint } from '../../scripts/ide.mjs';

const roots: string[] = [];
function put(filename: string, contents: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}
function fixture(source: string | null = '{}\n') {
  // macOS exposes /private/var through /var; fixtures use the canonical root so
  // deliberate linked-profile rejection is not confused with the system alias.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ide-test-')));
  roots.push(root);
  const resources = path.join(root, 'Antigravity IDE/resources');
  const app = path.join(resources, 'app');
  put(path.join(app, 'package.json'), JSON.stringify({ main: './out/main.js', version: '1.107.0' }));
  put(path.join(app, 'product.json'), JSON.stringify({ nameShort: 'Antigravity IDE', applicationName: 'antigravity-ide' }));
  put(path.join(app, 'out/main.js'), '// Vendor boot remains untouched\n');
  put(path.join(app, 'extensions/antigravity/package.json'), JSON.stringify({ contributes: { configuration: { properties: { 'jetski.cloudCodeUrl': { type: 'string' } } } } }));
  const settings = path.join(root, 'profile/User/settings.json');
  if (source !== null) put(settings, source);
  const executable = path.join(path.dirname(resources), 'Antigravity IDE.exe');
  put(executable, 'fixture executable - never run');
  return { root, resources, settings, executable, platform: 'win32', app };
}
function hubEndpointFixture() {
  const f = fixture();
  put(path.join(f.app, 'product.json'), JSON.stringify({ nameShort: 'Antigravity IDE', applicationName: 'antigravity-ide', ideVersion: '2.6.0', commit: '9e3a5da5d6731effd57d47d88bbe5df14ac6ccdd' }));
  put(path.join(f.app, 'extensions/antigravity/package.json'), '{}');
  put(path.join(f.app, 'extensions/agy/package.json'), JSON.stringify({ name: 'google-antigravity', publisher: 'google', main: './dist/extension.js' }));
  put(path.join(f.app, 'out/main.js'), 'cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl");this.makePostRequest("v1internal:fetchAvailableModels",eSt);');
  put(path.join(f.app, 'extensions/agy/vscode/extension.js'), [
    '["--hub"',
    '"--app_data_dir=antigravity"',
    '`--csrf_token=${this.csrfToken}`',
    'AGY_ENABLE_HUB:"1",ANTIGRAVITY_VSCODE_HOST:"1",ANTIGRAVITY_AUTH_SUCCESS_APP:n.env.uriScheme||"vscode"};',
  ].join(','));
  return f;
}
function coreEndpointFixture() {
  const f = fixture();
  put(path.join(f.app, 'product.json'), JSON.stringify({ nameShort: 'Antigravity IDE', applicationName: 'antigravity-ide', ideVersion: '2.5.5', commit: 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8' }));
  put(path.join(f.app, 'extensions/antigravity/package.json'), JSON.stringify({ name: 'antigravity', publisher: 'google', main: './dist/extension.js' }));
  // Small source excerpts from the official IDE 2.5.5 entry points, without any
  // vendor auth constants or execution of vendor code in the test process.
  put(path.join(f.app, 'out/main.js'), 'cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl");this.makePostRequest("v1internal:fetchAvailableModels",eSt);x.client.setCloudCodeURL(Ur(oSt,{url:await this.getCloudCodeUrl()}))');
  put(path.join(f.app, 'extensions/antigravity/dist/extension.js'), 'const x=await o.getCloudCodeUrl();_.push("--cloud_code_endpoint",x),_.push("--subclient_type","ide")');
  return f;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^agy-ide-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IDE JSONC settings', () => {
  it('handles comments, quoted punctuation, nesting, BOM and trailing commas without reformatting other keys', () => {
    const source = '\ufeff{\r\n  // Theme\r\n  "theme": "a,b} // value",\r\n  "nested": [{ "x": true, }], /* keep */\r\n}\r\n';
    const updated = editSetting(source, '"http://127.0.0.1:50999"');
    expect(updated.startsWith(source.slice(0, source.lastIndexOf('}')))).toBe(true);
    expect(updated).toContain('"jetski.cloudCodeUrl": "http://127.0.0.1:50999"');
    expect(parseSettings(updated).entries).toHaveLength(3);
  });
  it('adds the comma before a trailing line comment', () => {
    const updated = editSetting('{ "theme": "dark" // keep\n}', '"local"');
    expect(updated).toContain('"dark", // keep');
    expect(parseSettings(updated).entries).toHaveLength(2);
  });
  it.each([
    '{"jetski.cloudCodeUrl":"x","other":1}',
    '{"other":1,"jetski.cloudCodeUrl":"x"}',
    '{"other":1,"jetski.cloudCodeUrl":"x",}',
    '{"jetski.cloudCodeUrl":"x",}',
  ])('removes only the managed key with correct comma handling: %s', (source) => {
    const updated = editSetting(source, null);
    expect(updated).not.toContain('jetski.cloudCodeUrl');
    expect(parseSettings(updated).entries.every((entry: { key: { value: string } }) => entry.key.value === 'other')).toBe(true);
  });
  it.each(['{broken}', '{"x":undefined}', '{"x":01}', '{"x":1} trailing', '{"x":1,,}', '{"x":[,]}', '{"x":1,"x":2}', '{/* open', '[]', '{"x":"bad\nstring"}'])('rejects malformed or ambiguous JSONC: %s', (source) => {
    expect(() => parseSettings(source)).toThrow('INVALID_SETTINGS');
  });
  it('rejects deep settings nesting without overflowing the stack', () => {
    expect(() => parseSettings('{"x":' + '['.repeat(110) + '0' + ']'.repeat(110) + '}')).toThrow('INVALID_SETTINGS');
  });
});

describe('verified IDE endpoint adapter', () => {
  it('recognizes the inspected IDE 2.5.5 core setting even when its extension does not declare it', () => {
    const f = coreEndpointFixture();
    const originalCore = fs.readFileSync(path.join(f.app, 'out/main.js'));
    const originalExtension = fs.readFileSync(path.join(f.app, 'extensions/antigravity/dist/extension.js'));
    expect(inspectIde(f).declaredBy).toBe('core:antigravity-ide-2.5.5');
    expect(configureIde({ ...f, action: 'check' })).toMatchObject({ version: '1.107.0', ideVersion: '2.5.5' });
    expect(configureIde({ ...f, action: 'apply' }).applied).toBe(true);
    expect(configureIde({ ...f, action: 'restore' }).status).toBe('restored');
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(f.app, 'out/main.js'))).toEqual(originalCore);
    expect(fs.readFileSync(path.join(f.app, 'extensions/antigravity/dist/extension.js'))).toEqual(originalExtension);
  });
  it('recognizes IDE 2.6.0 and points its hub at the loopback proxy without editing core', () => {
    const f = hubEndpointFixture();
    const launcher = path.join(f.app, 'extensions/agy/vscode/extension.js');
    const originalLauncher = fs.readFileSync(launcher);
    const originalCore = fs.readFileSync(path.join(f.app, 'out/main.js'));
    expect(inspectIde(f).declaredBy).toBe('core:antigravity-ide-2.6.0');
    expect(configureIde({ ...f, action: 'apply' })).toMatchObject({ applied: true, ideVersion: '2.6.0', launcherPatched: true });
    const patched = fs.readFileSync(launcher, 'utf8');
    expect(patched.match(/var agyGatewayUrl/g)).toHaveLength(1);
    expect(patched).toContain('127\\.0\\.0\\.1');
    expect(configureIde({ ...f, action: 'apply' }).status).toBe('unchanged');
    expect(fs.readFileSync(launcher, 'utf8').match(/var agyGatewayUrl/g)).toHaveLength(1);
    expect(configureIde({ ...f, action: 'restore' }).launcherRestored).toBe(true);
    expect(fs.readFileSync(launcher)).toEqual(originalLauncher);
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(f.app, 'out/main.js'))).toEqual(originalCore);
  });
  it('recognizes the Linux IDE 2.6.0 release commit reported in issue #42', () => {
    const f = { ...hubEndpointFixture(), platform: 'linux' };
    const product = path.join(f.app, 'product.json');
    put(product, fs.readFileSync(product, 'utf8').replace('9e3a5da5d6731effd57d47d88bbe5df14ac6ccdd', '895a06674a2fc1c62bc9d2219cd28c254fb80ed7'));
    const launcher = path.join(f.app, 'extensions/agy/vscode/extension.js');
    const originalLauncher = fs.readFileSync(launcher);
    expect(inspectIde(f).declaredBy).toBe('core:antigravity-ide-2.6.0');
    expect(configureIde({ ...f, action: 'apply' })).toMatchObject({ applied: true, launcherPatched: true });
    expect(configureIde({ ...f, action: 'restore' }).launcherRestored).toBe(true);
    expect(fs.readFileSync(launcher)).toEqual(originalLauncher);
  });
  it('still refuses an unknown IDE 2.6.0 release commit', () => {
    const f = hubEndpointFixture();
    const product = path.join(f.app, 'product.json');
    put(product, fs.readFileSync(product, 'utf8').replace('9e3a5da5d6731effd57d47d88bbe5df14ac6ccdd', '0'.repeat(40)));
    expect(() => inspectIde(f)).toThrow('UNSUPPORTED_IDE');
  });
  it('refuses an IDE 2.6.0 launcher without the hub environment hook before writing settings', () => {
    const f = hubEndpointFixture();
    const launcher = path.join(f.app, 'extensions/agy/vscode/extension.js');
    fs.writeFileSync(launcher, fs.readFileSync(launcher, 'utf8').replace('AGY_ENABLE_HUB', 'AGY_DISABLED'));
    expect(() => configureIde({ ...f, action: 'apply' })).toThrow('UNSUPPORTED_IDE');
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
    expect(fs.existsSync(`${f.settings}.antigravity-model-patch`)).toBe(false);
  });
  it.each(['core-setting', 'catalog', 'ls-update', 'ls-launch', 'ide-subclient', 'release', 'publisher'])(
    'refuses an unverified core layout missing %s before modifying settings', (missing) => {
      const f = coreEndpointFixture();
      const core = path.join(f.app, 'out/main.js');
      const launcher = path.join(f.app, 'extensions/antigravity/dist/extension.js');
      const replacements: Record<string, [string, string]> = {
        'core-setting': [core, 'jetski.cloudCodeUrl'],
        catalog: [core, 'v1internal:fetchAvailableModels'],
        'ls-update': [core, 'setCloudCodeURL'],
        'ls-launch': [launcher, '--cloud_code_endpoint'],
        'ide-subclient': [launcher, '--subclient_type'],
        release: [path.join(f.app, 'product.json'), 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8'],
        publisher: [path.join(f.app, 'extensions/antigravity/package.json'), 'google'],
      };
      const [filename, needle] = replacements[missing]!;
      fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(needle, 'unrecognized'));
      expect(() => configureIde({ ...f, action: 'apply' })).toThrow('UNSUPPORTED_IDE');
      expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
      expect(fs.existsSync(`${f.settings}.antigravity-model-patch`)).toBe(false);
    },
  );
  it('checks without writing or changing vendor runtime', () => {
    const f = fixture();
    const before = fs.readFileSync(path.join(f.app, 'out/main.js'));
    const report = configureIde({ ...f, action: 'check' });
    expect(report.status).toBe('unconfigured');
    expect(fs.existsSync(`${f.settings}.antigravity-model-patch`)).toBe(false);
    expect(fs.readFileSync(path.join(f.app, 'out/main.js'))).toEqual(before);
  });
  it('applies idempotently and restores original settings byte for byte', () => {
    const original = '{\r\n// keep my config\r\n"jetski.cloudCodeUrl": "https://example.test/old",\r\n"theme":"dark",\r\n}\r\n';
    const f = fixture(original);
    expect(configureIde({ ...f, action: 'apply' }).status).toBe('configured');
    const patched = fs.readFileSync(f.settings);
    expect(configureIde({ ...f, action: 'apply' }).status).toBe('unchanged');
    expect(fs.readFileSync(f.settings)).toEqual(patched);
    expect(configureIde({ ...f, action: 'status' }).applied).toBe(true);
    configureIde({ ...f, action: 'restore' });
    expect(fs.readFileSync(f.settings, 'utf8')).toBe(original);
    expect(configureIde({ ...f, action: 'restore' }).status).toBe('unchanged');
    expect(configureIde({ ...f, action: 'apply' }).applied).toBe(true);
  });
  it('restores its setting while preserving later unrelated edits and comments', () => {
    const f = fixture('{ "jetski.cloudCodeUrl": "https://old.test", "theme": "dark" }');
    configureIde({ ...f, action: 'apply' });
    const changed = fs.readFileSync(f.settings, 'utf8').replace('"dark"', '"light" /* user edit */');
    fs.writeFileSync(f.settings, changed);
    expect(configureIde({ ...f, action: 'restore' }).preservedOtherEdits).toBe(true);
    const restored = fs.readFileSync(f.settings, 'utf8');
    expect(restored).toContain('"light" /* user edit */');
    expect(restored).toContain('https://old.test');
    expect(restored).not.toContain('50999');
  });
  it('removes a newly created settings file only when it is still unmodified', () => {
    const f = fixture(null);
    configureIde({ ...f, action: 'apply' });
    configureIde({ ...f, action: 'restore' });
    expect(fs.existsSync(f.settings)).toBe(false);
    configureIde({ ...f, action: 'apply' });
    fs.writeFileSync(f.settings, fs.readFileSync(f.settings, 'utf8').replace('{', '{ "theme": "light",'));
    configureIde({ ...f, action: 'restore' });
    expect(parseSettings(fs.readFileSync(f.settings, 'utf8')).entries).toHaveLength(1);
    expect(fs.readFileSync(f.settings, 'utf8')).toContain('light');
  });
  it('rejects external endpoint changes on restore and reapply without overwriting them', () => {
    const f = fixture();
    configureIde({ ...f, action: 'apply' });
    const changed = '{"jetski.cloudCodeUrl":"https://user-choice.test"}';
    fs.writeFileSync(f.settings, changed);
    expect(configureIde({ ...f, action: 'status' }).status).toBe('conflict');
    expect(() => configureIde({ ...f, action: 'restore' })).toThrow('RESTORE_REFUSED');
    expect(() => configureIde({ ...f, action: 'apply' })).toThrow('SETTINGS_CONFLICT');
    expect(fs.readFileSync(f.settings, 'utf8')).toBe(changed);
  });
  it('rejects altered backups before touching current settings', () => {
    const f = fixture();
    configureIde({ ...f, action: 'apply' });
    const before = fs.readFileSync(f.settings);
    fs.writeFileSync(path.join(`${f.settings}.antigravity-model-patch`, 'original.jsonc'), '{"tampered":true}');
    expect(() => configureIde({ ...f, action: 'restore' })).toThrow('BACKUP_INVALID');
    expect(fs.readFileSync(f.settings)).toEqual(before);
  });
  it('can recover the prepared state after an interrupted settings write', () => {
    const f = fixture();
    configureIde({ ...f, action: 'apply' });
    const manifest = path.join(`${f.settings}.antigravity-model-patch`, 'state.json');
    const state = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    state.status = 'prepared'; fs.writeFileSync(manifest, JSON.stringify(state));
    fs.writeFileSync(f.settings, '{}\n');
    expect(configureIde({ ...f, action: 'apply' }).status).toBe('configured');
    configureIde({ ...f, action: 'restore' });
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
  });
  it('fails before creating any backup on invalid settings, ports or unsupported installations', () => {
    const f = fixture('{broken}');
    expect(() => configureIde({ ...f, action: 'apply' })).toThrow('INVALID_SETTINGS');
    expect(fs.existsSync(`${f.settings}.antigravity-model-patch`)).toBe(false);
    fs.writeFileSync(f.settings, '{}');
    expect(() => configureIde({ ...f, action: 'apply', port: 0 })).toThrow('INVALID_PORT');
    expect(() => configureIde({ ...f, action: 'apply', proxyUrl: 'http://example.test:50999' })).toThrow('INVALID_PROXY_URL');
    fs.writeFileSync(path.join(f.app, 'extensions/antigravity/package.json'), '{}');
    expect(() => configureIde({ ...f, action: 'apply' })).toThrow('UNSUPPORTED_IDE');
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}');
    expect(fs.existsSync(`${f.settings}.antigravity-model-patch`)).toBe(false);
  });
  it('rejects another application even if it exposes a similarly named setting', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.app, 'product.json'), '{"nameShort":"Code","applicationName":"code"}');
    expect(() => inspectIde(f)).toThrow('UNSUPPORTED_IDE');
  });
  it('refuses settings reached through a junction or symlink', () => {
    const f = fixture();
    const linked = path.join(f.root, 'linked-profile');
    fs.symlinkSync(path.dirname(f.settings), linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => configureIde({ ...f, settings: path.join(linked, 'settings.json'), action: 'apply' })).toThrow('UNSAFE_PATH');
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}\n');
  });
  it('supports array-form configuration contributions and product-specific settings discovery', () => {
    const f = fixture();
    put(path.join(f.app, 'extensions/antigravity/package.json'), JSON.stringify({ contributes: { configuration: [{ properties: { 'jetski.cloudCodeUrl': { type: 'string' } } }] } }));
    const result = inspectIde({ resources: path.dirname(f.resources), platform: 'win32', env: { APPDATA: f.root } });
    expect(result.settings).toBe(path.join(f.root, 'Antigravity IDE/User/settings.json'));
    expect(result.declaredBy).toBe('antigravity');
  });
  it('never launches the IDE until the owned proxy is ready', async () => {
    const f = fixture();
    configureIde({ ...f, action: 'apply', port: 51123 });
    const calls: string[] = [];
    await launchIde(f, { startService: async ({ port }: { port: number }) => { expect(port).toBe(51123); calls.push('healthy'); }, launch: async (exe: string, args: string[]) => { expect(exe).toBe(f.executable); expect(args).toEqual(['--user-data-dir', path.join(f.root, 'profile')]); calls.push('IDE'); } });
    expect(calls).toEqual(['healthy', 'IDE']);
    const launch = vi.fn();
    await expect(launchIde(f, { startService: async () => { throw new Error('port owned by another process'); }, launch })).rejects.toThrow('port owned');
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects launch with unconfigured settings, a different port or an unrelated executable before starting the service', async () => {
    const f = fixture();
    const startService = vi.fn();
    await expect(launchIde(f, { startService })).rejects.toThrow('IDE_NOT_CONFIGURED');
    configureIde({ ...f, action: 'apply' });
    await expect(launchIde({ ...f, port: 51111 }, { startService })).rejects.toThrow('SETTINGS_CONFLICT');
    await expect(launchIde({ ...f, executable: process.execPath }, { startService })).rejects.toThrow('IDE_EXECUTABLE_NOT_FOUND');
    expect(startService).not.toHaveBeenCalled();
  });
  it('rejects concurrent mutation and changed-port application', () => {
    const f = fixture();
    configureIde({ ...f, action: 'apply' });
    expect(() => configureIde({ ...f, action: 'apply', port: 51111 })).toThrow('SETTINGS_CONFLICT');
    put(path.join(`${f.settings}.antigravity-model-patch`, 'lock'), '');
    expect(() => configureIde({ ...f, action: 'restore' })).toThrow('INSTALL_BUSY');
  });
  it('rejects automatic launch into an unidentified named profile', async () => {
    const f = fixture();
    const named = { ...f, settings: path.join(f.root, 'profile/User/profiles/abc/settings.json') };
    configureIde({ ...named, action: 'apply' });
    const startService = vi.fn();
    await expect(launchIde(named, { startService })).rejects.toThrow('UNSUPPORTED_PROFILE');
    expect(startService).not.toHaveBeenCalled();
  });
  it('validates CLI input', () => {
    expect(parseIdeArgs(['apply', '--resources', 'path with spaces', '--port', '50999'])).toEqual({ action: 'apply', resources: 'path with spaces', port: '50999' });
    expect(() => parseIdeArgs(['invalid'])).toThrow('INVALID_ARGUMENT');
    expect(() => parseIdeArgs(['apply', '--resources'])).toThrow('INVALID_ARGUMENT');
    expect(proxyEndpoint({ port: '51000' })).toBe('http://127.0.0.1:51000');
  });
});
