#!/usr/bin/env node
/** Configure a verified IDE endpoint setting without modifying vendor code. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SETTING = 'jetski.cloudCodeUrl';
const SERVICE = fileURLToPath(new URL('./desktop-service.mjs', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const MAX_SETTINGS = 4 * 1024 * 1024;
// IDE 2.5.5 consumes this hidden setting in its core and language-server
// launcher, although the bundled extension does not contribute it as a setting.
// Keep this exception limited to the official release actually inspected.
const CORE_ENDPOINT_RELEASE = 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8';
// IDE 2.6.0 still reads jetski.cloudCodeUrl in the Electron client, but its
// language-server hub no longer receives --cloud_code_endpoint. The `agy` hub
// reads CLOUD_CODE_URL instead (#42), which keeps the native Cloud Code catalog
// and generation path. Keep the exception limited to these release commits and
// the exact launcher shape checked below.
const HUB_ENDPOINT_RELEASES = new Set([
  // Windows build, verified live in PR #40. macOS reports the same commit (#41).
  '9e3a5da5d6731effd57d47d88bbe5df14ac6ccdd',
  // Linux build reported in #42. Its launcher code matches the same anchor.
  '895a06674a2fc1c62bc9d2219cd28c254fb80ed7',
]);
const HUB_ENV_ANCHOR = 'AGY_ENABLE_HUB:"1",ANTIGRAVITY_VSCODE_HOST:"1",ANTIGRAVITY_AUTH_SUCCESS_APP:n.env.uriScheme||"vscode"};';
const HUB_CLOUD_CODE_MARKER = 'agyCloudCodeUrl';
const HUB_ENV_INJECTION = 'if(!c.CLOUD_CODE_URL){var agyCloudCodeUrl=n.workspace.getConfiguration().get("jetski.cloudCodeUrl");if(typeof agyCloudCodeUrl==="string"&&/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(agyCloudCodeUrl))c.CLOUD_CODE_URL=agyCloudCodeUrl}';
// Earlier releases injected AGY_LLM_GATEWAY_URL. That puts the hub in LLM-gateway
// mode, whose model list replaces the native Google models (#46). Apply upgrades
// it from the saved original launcher.
const LEGACY_HUB_GATEWAY_MARKER = 'agyGatewayUrl';
const LEGACY_HUB_ENV_INJECTION = 'if(!c.AGY_LLM_GATEWAY_URL){var agyGatewayUrl=n.workspace.getConfiguration().get("jetski.cloudCodeUrl");if(typeof agyGatewayUrl==="string"&&/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(agyGatewayUrl))c.AGY_LLM_GATEWAY_URL=agyGatewayUrl}';
const exec = promisify(execFile);
function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function exists(filename) {
  try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function noLinks(filename) {
  const resolved = path.resolve(filename);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', `Refusing linked path: ${current}`);
  }
}
function read(filename) {
  noLinks(filename);
  if (!exists(filename)) return null;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_SETTINGS) fail('INVALID_SETTINGS', 'Expected a settings file smaller than 4 MB.');
  return fs.readFileSync(filename);
}

/** Strict JSON plus comments/trailing commas, retaining ranges for surgical edits. */
export function parseSettings(source) {
  if (Buffer.byteLength(source, 'utf8') > MAX_SETTINGS) fail('INVALID_SETTINGS', 'Settings exceed 4 MB.');
  let offset = 0;
  const tokens = [];
  while (offset < source.length) {
    const start = offset;
    const char = source[offset];
    if (/\s/.test(char) || (offset === 0 && char === '\ufeff')) { offset++; continue; }
    if (source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset + 2); offset = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) fail('INVALID_SETTINGS', 'Unterminated comment.');
      offset = end + 2; continue;
    }
    if ('{}[]:,'.includes(char)) { tokens.push({ kind: char, start, end: ++offset }); continue; }
    if (char === '"') {
      offset++;
      while (offset < source.length) {
        if (source[offset] === '\\') { offset += 2; continue; }
        if (source[offset++] === '"') break;
      }
      let value;
      try { value = JSON.parse(source.slice(start, offset)); } catch { fail('INVALID_SETTINGS', 'Invalid JSON string.'); }
      tokens.push({ kind: 'string', start, end: offset, value }); continue;
    }
    const literal = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(source.slice(offset));
    if (!literal) fail('INVALID_SETTINGS', `Unexpected token at offset ${offset}.`);
    offset += literal[0].length;
    tokens.push({ kind: 'literal', start, end: offset, value: JSON.parse(literal[0]) });
  }
  let index = 0;
  function take(kind) {
    const token = tokens[index++];
    if (!token || token.kind !== kind) fail('INVALID_SETTINGS', `Expected ${kind}.`);
    return token;
  }
  function value(depth = 0) {
    if (depth > 100) fail('INVALID_SETTINGS', 'Settings nesting is too deep.');
    const token = tokens[index];
    if (!token) fail('INVALID_SETTINGS', 'Missing JSON value.');
    if (token.kind === 'string' || token.kind === 'literal') { index++; return token; }
    if (token.kind !== '{' && token.kind !== '[') fail('INVALID_SETTINGS', 'Expected a JSON value.');
    index++;
    const object = token.kind === '{';
    const close = object ? '}' : ']';
    const entries = [];
    const names = new Set();
    while (tokens[index]?.kind !== close) {
      let key;
      if (object) {
        key = take('string'); take(':');
        if (names.has(key.value)) fail('INVALID_SETTINGS', `Duplicate setting/property: ${key.value}`);
        names.add(key.value);
      }
      const item = value(depth + 1);
      const entry = { key, value: item, start: key?.start ?? item.start, end: item.end };
      entries.push(entry);
      if (tokens[index]?.kind === close) break;
      entry.comma = take(',');
    }
    const end = take(close);
    return { kind: token.kind, start: token.start, end: end.end, close: end.start, entries };
  }
  const root = value();
  if (root.kind !== '{' || index !== tokens.length) fail('INVALID_SETTINGS', 'Settings must contain exactly one JSON object.');
  return root;
}
function setting(source) { return parseSettings(source).entries.find(entry => entry.key.value === SETTING); }
export function editSetting(source, rawValue) {
  const tree = parseSettings(source);
  const position = tree.entries.findIndex(entry => entry.key.value === SETTING);
  const entry = tree.entries[position];
  let result;
  if (entry && rawValue !== null) result = source.slice(0, entry.value.start) + rawValue + source.slice(entry.value.end);
  else if (entry) {
    const edits = [{ start: entry.start, end: entry.end }];
    const comma = entry.comma || tree.entries[position - 1]?.comma;
    if (comma) edits.push({ start: comma.start, end: comma.end });
    result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + result.slice(edit.end);
  } else if (rawValue !== null) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const last = tree.entries.at(-1);
    result = source;
    // Place the separator immediately after the old value, before a line comment.
    if (last && !last.comma) result = result.slice(0, last.end) + ',' + result.slice(last.end);
    const closing = tree.close + (last && !last.comma ? 1 : 0);
    result = result.slice(0, closing) + `${newline}  ${JSON.stringify(SETTING)}: ${rawValue}${newline}` + result.slice(closing);
  } else result = source;
  parseSettings(result);
  return result;
}

export function proxyEndpoint(options = {}) {
  const port = options.port === undefined ? 50999 : Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('INVALID_PORT', 'Choose a fixed port from 1024 to 65535.');
  const expected = `http://127.0.0.1:${port}`;
  if (options.proxyUrl !== undefined && options.proxyUrl !== expected) {
    fail('INVALID_PROXY_URL', `The managed IDE proxy must use ${expected}; remote providers belong in model configuration.`);
  }
  return expected;
}
function jsonFile(filename) {
  noLinks(filename);
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('UNSUPPORTED_IDE', `Cannot read ${filename}.`); }
}
function coreEndpointSupport(app, pkg, product) {
  if (pkg.version !== '1.107.0' || product.ideVersion !== '2.5.5' || product.commit !== CORE_ENDPOINT_RELEASE ||
      product.nameShort !== 'Antigravity IDE' || product.applicationName !== 'antigravity-ide') return false;
  const extensionRoot = path.join(app, 'extensions/antigravity');
  const manifest = path.join(extensionRoot, 'package.json');
  if (!exists(manifest)) return false;
  const extension = jsonFile(manifest);
  if (extension.name !== 'antigravity' || extension.publisher !== 'google' ||
      extension.main !== './dist/extension.js') return false;
  const sources = [path.join(app, 'out/main.js'), path.join(extensionRoot, 'dist/extension.js')];
  const text = [];
  for (const filename of sources) {
    noLinks(filename);
    if (!exists(filename)) return false;
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return false;
    text.push(fs.readFileSync(filename, 'utf8'));
  }
  const [core, launcher] = text;
  return core.includes('cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl")') &&
    core.includes('this.makePostRequest("v1internal:fetchAvailableModels",') &&
    /\.client\.setCloudCodeURL\([^;]{0,200}\{url:await this\.getCloudCodeUrl\(\)\}/.test(core) &&
    /const ([\w$]+)=await [\w$]+\.getCloudCodeUrl\(\);[\w$]+\.push\("--cloud_code_endpoint",\1\)/.test(launcher) &&
    launcher.includes('.push("--subclient_type","ide")');
}
function readBounded(filename) {
  noLinks(filename);
  if (!exists(filename)) return null;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
  return fs.readFileSync(filename);
}
function hubLauncherPath(app) {
  return path.join(app, 'extensions/agy/vscode/extension.js');
}
function hubEndpointSupport(app, pkg, product) {
  if (pkg.version !== '1.107.0' || product.ideVersion !== '2.6.0' || !HUB_ENDPOINT_RELEASES.has(product.commit) ||
      product.nameShort !== 'Antigravity IDE' || product.applicationName !== 'antigravity-ide') return false;
  const manifest = path.join(app, 'extensions/agy/package.json');
  if (!exists(manifest)) return false;
  const extension = jsonFile(manifest);
  if (extension.name !== 'google-antigravity' || extension.publisher !== 'google' ||
      extension.main !== './dist/extension.js') return false;
  const core = readBounded(path.join(app, 'out/main.js'));
  const launcher = readBounded(hubLauncherPath(app));
  if (!core || !launcher) return false;
  const coreText = core.toString('utf8');
  const launcherText = launcher.toString('utf8');
  return coreText.includes('cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl")') &&
    coreText.includes('this.makePostRequest("v1internal:fetchAvailableModels",') &&
    launcherText.includes('["--hub"') &&
    launcherText.includes('"--app_data_dir=antigravity"') &&
    launcherText.includes('`--csrf_token=${this.csrfToken}`') &&
    launcherText.includes('AGY_ENABLE_HUB:"1"') &&
    launcherText.includes(HUB_ENV_ANCHOR);
}
function hubInjection(original, injection) {
  return Buffer.from(original.toString('utf8').replace(HUB_ENV_ANCHOR, HUB_ENV_ANCHOR + injection));
}
function hubLauncherBackup(names) {
  const backup = readBounded(path.join(names.directory, 'launcher.original.js'));
  const text = backup?.toString('utf8');
  if (!backup || text.split(HUB_ENV_ANCHOR).length !== 2 || text.includes(HUB_CLOUD_CODE_MARKER) || text.includes(LEGACY_HUB_GATEWAY_MARKER)) {
    fail('BACKUP_INVALID', 'IDE 2.6.0 launcher backup is missing or changed.');
  }
  return backup;
}
function syncHubLauncher(info, names) {
  if (info.declaredBy !== 'core:antigravity-ide-2.6.0') return {};
  const filename = hubLauncherPath(info.app);
  const current = readBounded(filename);
  if (!current) fail('UNSUPPORTED_IDE', 'IDE 2.6.0 language-server launcher was not found.');
  const source = current.toString('utf8');
  const backupName = path.join(names.directory, 'launcher.original.js');
  if (source.includes(HUB_CLOUD_CODE_MARKER)) {
    const backup = hubLauncherBackup(names);
    if (!current.equals(hubInjection(backup, HUB_ENV_INJECTION))) {
      fail('LAUNCHER_CHANGED', 'The IDE 2.6.0 launcher or its saved original was changed after patching. Repair or reinstall the IDE, then apply again.');
    }
    return { launcher: { path: filename, originalHash: hash(backup), patchedHash: hash(current) }, launcherChanged: false };
  }
  if (source.includes(LEGACY_HUB_GATEWAY_MARKER)) {
    const backup = hubLauncherBackup(names);
    if (!current.equals(hubInjection(backup, LEGACY_HUB_ENV_INJECTION))) {
      fail('LAUNCHER_CHANGED', 'The IDE 2.6.0 launcher was edited after the earlier patch. Restore or reinstall the IDE, then apply again.');
    }
    const patched = hubInjection(backup, HUB_ENV_INJECTION);
    atomic(filename, patched);
    return { launcher: { path: filename, originalHash: hash(backup), patchedHash: hash(patched) }, launcherChanged: true };
  }
  if (!source.includes(HUB_ENV_ANCHOR) || source.split(HUB_ENV_ANCHOR).length !== 2) {
    fail('UNSUPPORTED_IDE', 'IDE 2.6.0 launcher does not contain the verified hub environment hook.');
  }
  const patched = hubInjection(current, HUB_ENV_INJECTION);
  noLinks(backupName);
  atomic(backupName, current);
  try {
    atomic(filename, patched);
  } catch (error) {
    if (exists(backupName)) fs.unlinkSync(backupName);
    throw error;
  }
  return { launcher: { path: filename, originalHash: hash(current), patchedHash: hash(patched) }, launcherChanged: true };
}
function restoreHubLauncher(info, state, names) {
  if (!state?.launcher) return false;
  // Only this installation's launcher is ever written, and only with the original it was patched from.
  const filename = hubLauncherPath(info.app);
  const backup = readBounded(path.join(names.directory, 'launcher.original.js'));
  const current = readBounded(filename);
  if (!backup || !current || hash(backup) !== state.launcher.originalHash || hash(current) !== state.launcher.patchedHash) return false;
  if (![HUB_ENV_INJECTION, LEGACY_HUB_ENV_INJECTION].some(injection => current.equals(hubInjection(backup, injection)))) return false;
  atomic(filename, backup);
  return true;
}
export function inspectIde(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const initial = options.resources ? [path.resolve(options.resources)] : platform === 'win32'
    ? [path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/Antigravity IDE'), path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/Antigravity')]
    : platform === 'darwin' ? ['/Applications/Antigravity IDE.app', '/Applications/Antigravity.app', path.join(home, 'Applications/Antigravity IDE.app')]
      : ['/opt/antigravity-ide', '/opt/antigravity', '/usr/share/antigravity', '/usr/lib/antigravity', path.join(home, '.local/share/antigravity-ide')];
  const candidates = initial.flatMap(root => [root, path.join(root, 'resources'), path.join(root, 'Contents/Resources')]);
  for (const resources of candidates) {
    const app = path.join(resources, 'app');
    if (!exists(path.join(app, 'package.json'))) continue;
    noLinks(app);
    const pkg = jsonFile(path.join(app, 'package.json'));
    const product = jsonFile(path.join(app, 'product.json'));
    if (String(pkg.main).replace(/^\.\//, '') !== 'out/main.js' || !exists(path.join(app, 'out/main.js')) ||
        !/^antigravity(?: ide)?$/i.test(product.nameShort || '') || !/^[a-z0-9-]+$/i.test(product.applicationName || '')) {
      fail('UNSUPPORTED_IDE', 'Expected the VS Code-based Antigravity IDE with out/main.js and matching product metadata.');
    }
    noLinks(path.join(app, 'out/main.js'));
    const extensions = path.join(app, 'extensions');
    noLinks(extensions);
    let declaredBy;
    if (exists(extensions)) for (const name of fs.readdirSync(extensions)) {
      const extension = path.join(extensions, name);
      noLinks(extension);
      const manifest = path.join(extension, 'package.json');
      if (!fs.statSync(extension).isDirectory() || !exists(manifest)) continue;
      const extensionPkg = jsonFile(manifest);
      const configuration = extensionPkg.contributes?.configuration;
      for (const config of Array.isArray(configuration) ? configuration : [configuration]) {
        if (config?.properties?.[SETTING]?.type === 'string') declaredBy = name;
      }
    }
    if (!declaredBy && coreEndpointSupport(app, pkg, product)) declaredBy = 'core:antigravity-ide-2.5.5';
    if (!declaredBy && hubEndpointSupport(app, pkg, product)) declaredBy = 'core:antigravity-ide-2.6.0';
    if (!declaredBy) fail('UNSUPPORTED_IDE', `This installation does not declare ${SETTING} or match a verified core endpoint implementation; no files changed.`);
    const userRoot = platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), product.nameShort)
      : platform === 'darwin' ? path.join(home, 'Library/Application Support', product.nameShort)
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), product.nameShort);
    const settings = path.resolve(options.settings || path.join(userRoot, 'User/settings.json'));
    noLinks(settings);
    return { resources: path.resolve(resources), app, settings, version: String(pkg.version || 'unknown'),
      ideVersion: typeof product.ideVersion === 'string' ? product.ideVersion : undefined, product, declaredBy, platform };
  }
  fail('IDE_NOT_FOUND', 'No supported IDE found. Pass --resources PATH and, for a custom profile, --settings FILE.');
}
function paths(info) {
  const directory = `${info.settings}.antigravity-model-patch`;
  return { directory, state: path.join(directory, 'state.json'), backup: path.join(directory, 'original.jsonc'), lock: path.join(directory, 'lock') };
}
function atomic(filename, contents) {
  noLinks(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const mode = exists(filename) ? fs.statSync(filename).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode });
    fs.renameSync(temporary, filename);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function loadState(info) {
  const names = paths(info);
  noLinks(names.state); noLinks(names.backup);
  if (!exists(names.state)) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(names.state, 'utf8')); } catch { fail('INVALID_STATE', 'Cannot read IDE patch manifest.'); }
  if (state.schema !== 1 || state.settings !== info.settings || state.resources !== info.resources ||
      !['prepared', 'active', 'restored'].includes(state.status) || typeof state.originalExists !== 'boolean' ||
      !HASH.test(state.originalHash) || !HASH.test(state.patchedHash) || !Number.isInteger(state.port) ||
      state.endpoint !== proxyEndpoint({ port: state.port })) fail('INVALID_STATE', 'Invalid IDE patch manifest.');
  if (state.launcher !== undefined && (state.launcher === null || typeof state.launcher !== 'object' || typeof state.launcher.path !== 'string' ||
      !HASH.test(state.launcher.originalHash) || !HASH.test(state.launcher.patchedHash))) fail('INVALID_STATE', 'Invalid IDE patch manifest.');
  const backup = read(names.backup);
  if (!backup || hash(backup) !== state.originalHash) fail('BACKUP_INVALID', 'Original IDE settings backup is missing or changed.');
  parseSettings(backup.toString('utf8'));
  return { ...state, backup };
}
function stateBytes(state) { const { backup: _backup, ...saved } = state; return JSON.stringify(saved, null, 2) + '\n'; }
function current(info) {
  const bytes = read(info.settings);
  const source = bytes?.toString('utf8') ?? '{}\n';
  const entry = setting(source);
  if (entry && entry.value.kind !== 'string') fail('INVALID_SETTINGS', `${SETTING} must be a string.`);
  return { bytes, source, entry, endpoint: entry?.value.value };
}
function checkUnchanged(info, before) {
  const now = read(info.settings);
  if ((now === null) !== (before === null) || (now && hash(now) !== hash(before))) fail('SETTINGS_CONFLICT', 'Settings changed during this operation; retry after saving the IDE settings.');
}

export function configureIde(options = {}) {
  const info = inspectIde(options);
  const action = options.action || 'check';
  if (!['check', 'apply', 'restore', 'status'].includes(action)) fail('INVALID_ACTION', 'Use check, apply, restore, status or launch.');
  let endpoint = proxyEndpoint(options);
  let state = loadState(info);
  if (action !== 'apply' && options.port === undefined && state) endpoint = state.endpoint;
  let now = current(info);
  const summary = { action, resources: info.resources, settings: info.settings, version: info.version,
    ideVersion: info.ideVersion, endpoint, declaredBy: info.declaredBy };
  const applied = state?.status !== 'restored' && !!state && now.endpoint === state.endpoint;
  if (action === 'check' || action === 'status') {
    const legacyLauncher = info.declaredBy === 'core:antigravity-ide-2.6.0' &&
      !!readBounded(hubLauncherPath(info.app))?.toString('utf8').includes(LEGACY_HUB_GATEWAY_MARKER);
    return { ...summary, applied, status: applied ? 'configured' : state?.status === 'active' ? 'conflict' : 'unconfigured',
      managedEndpoint: state?.endpoint, ...(legacyLauncher ? { launcherUpdateNeeded: true } : {}) };
  }
  const names = paths(info);
  noLinks(names.directory);
  fs.mkdirSync(names.directory, { recursive: true, mode: 0o700 });
  noLinks(names.lock);
  let lock;
  try { lock = fs.openSync(names.lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('INSTALL_BUSY', `Another IDE settings operation is active. If interrupted, verify no installer is running before removing ${names.lock}.`);
    throw error;
  }
  try {
    state = loadState(info); now = current(info);
    if (action === 'restore') {
      if (!state || state.status === 'restored') return { ...summary, applied: false, status: 'unchanged' };
      const original = state.backup;
      const unchangedOriginal = (state.originalExists ? now.bytes && hash(now.bytes) === state.originalHash : now.bytes === null);
      if (state.status === 'prepared' && unchangedOriginal) {
        const launcherRestored = restoreHubLauncher(info, state, names);
        atomic(names.state, stateBytes({ ...state, status: 'restored' }));
        return { ...summary, applied: false, status: 'restored', launcherRestored };
      }
      if (now.endpoint !== state.endpoint) fail('RESTORE_REFUSED', `${SETTING} was changed outside this adapter; preserve your current settings and resolve the conflict first.`);
      const exact = now.bytes && hash(now.bytes) === state.patchedHash;
      const originalEntry = setting(original.toString('utf8'));
      const rawValue = originalEntry ? original.toString('utf8').slice(originalEntry.value.start, originalEntry.value.end) : null;
      const restored = exact ? original : Buffer.from(editSetting(now.source, rawValue));
      checkUnchanged(info, now.bytes);
      if (exact && !state.originalExists) fs.unlinkSync(info.settings);
      else atomic(info.settings, restored);
      atomic(names.state, stateBytes({ ...state, status: 'restored' }));
      return { ...summary, applied: false, status: 'restored', preservedOtherEdits: !exact, launcherRestored: restoreHubLauncher(info, state, names) };
    }
    if (state && state.status !== 'restored') {
      if (state.endpoint !== endpoint) fail('SETTINGS_CONFLICT', 'Restore the existing IDE adapter before choosing another proxy port.');
      if (now.endpoint === endpoint) {
        const { launcherChanged, ...launcher } = syncHubLauncher(info, names);
        if (state.status === 'prepared' || launcher.launcher) atomic(names.state, stateBytes({ ...state, ...launcher, status: 'active' }));
        return { ...summary, applied: true, status: launcherChanged ? 'updated' : 'unchanged', launcherPatched: Boolean(launcher.launcher) };
      }
      const original = state.originalExists ? now.bytes && hash(now.bytes) === state.originalHash : now.bytes === null;
      if (state.status !== 'prepared' || !original) fail('SETTINGS_CONFLICT', 'The managed IDE setting was changed outside this adapter. Restore or resolve it before applying again.');
    }
    const original = state && state.status === 'prepared' ? state.backup : Buffer.from(now.source);
    const patched = Buffer.from(editSetting(now.source, JSON.stringify(endpoint)));
    const manifest = { schema: 1, status: 'prepared', settings: info.settings, resources: info.resources,
      originalExists: now.bytes !== null, originalHash: hash(original), patchedHash: hash(patched),
      endpoint, port: Number(new URL(endpoint).port), version: info.version };
    checkUnchanged(info, now.bytes);
    const launcher = syncHubLauncher(info, names);
    const { launcherChanged, ...savedLauncher } = launcher;
    Object.assign(manifest, savedLauncher);
    try {
      atomic(names.backup, original);
      atomic(names.state, stateBytes(manifest));
      checkUnchanged(info, now.bytes);
      atomic(info.settings, patched);
      atomic(names.state, stateBytes({ ...manifest, status: 'active' }));
    } catch (error) {
      if (launcherChanged) restoreHubLauncher(info, manifest, names);
      throw error;
    }
    return { ...summary, applied: true, status: 'configured', launcherPatched: Boolean(launcher.launcher) };
  } finally { fs.closeSync(lock); fs.unlinkSync(names.lock); }
}

function executableFor(info, requested) {
  const root = path.dirname(info.resources);
  const candidates = info.platform === 'win32'
    ? [path.join(root, `${info.product.nameShort}.exe`), path.join(root, 'Antigravity.exe'), path.join(root, 'Antigravity IDE.exe')]
    : info.platform === 'darwin'
      ? ['Electron', 'Antigravity', 'Antigravity IDE'].map(name => path.join(root, 'MacOS', name))
      : [path.join(root, info.product.applicationName)];
  const selected = requested ? path.resolve(requested) : candidates.find(filename => exists(filename));
  if (!selected || !candidates.includes(selected)) fail('IDE_EXECUTABLE_NOT_FOUND', 'Pass --executable with the installed IDE executable next to the verified resources directory.');
  noLinks(selected);
  if (!exists(selected) || !fs.statSync(selected).isFile()) fail('IDE_EXECUTABLE_NOT_FOUND', 'IDE executable was not found.');
  if (info.platform !== 'win32') fs.accessSync(selected, fs.constants.X_OK);
  return selected;
}
export async function launchIde(options = {}, hooks = {}) {
  const info = inspectIde(options);
  const state = loadState(info);
  const now = current(info);
  if (!state || state.status !== 'active' || now.endpoint !== state.endpoint) fail('IDE_NOT_CONFIGURED', 'Run ide apply first; the managed endpoint must still match.');
  if (options.port !== undefined && proxyEndpoint(options) !== state.endpoint) fail('SETTINGS_CONFLICT', 'Launch port does not match the configured IDE endpoint.');
  const executable = executableFor(info, options.executable);
  if (path.basename(info.settings) !== 'settings.json' || path.basename(path.dirname(info.settings)) !== 'User') {
    fail('UNSUPPORTED_PROFILE', 'Managed launch requires USER_DATA_DIR/User/settings.json. For a named profile, start the proxy separately and open that IDE profile manually.');
  }
  const launchArgs = ['--user-data-dir', path.dirname(path.dirname(info.settings))];
  const args = [SERVICE, 'start', '--port', String(state.port)];
  if (options.dataDir) args.push('--data-dir', path.resolve(options.dataDir));
  // The owned service verifies its listener before returning successfully. A
  // random process occupying the configured port must never count as ready.
  const start = hooks.startService || (async () => { await exec(process.execPath, args, { windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024 }); });
  await start({ port: state.port, dataDir: options.dataDir });
  const env = info.declaredBy === 'core:antigravity-ide-2.6.0' ? { ...process.env, CLOUD_CODE_URL: state.endpoint } : undefined;
  const launch = hooks.launch || (async () => {
    // This is the interactive IDE, not the background service: SW_HIDE leaves
    // Electron's first restored window invisible on Windows.
    const child = spawn(executable, launchArgs, { detached: true, stdio: 'ignore', windowsHide: false, env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  });
  await launch(executable, launchArgs, env);
  return { action: 'launch', status: 'launched', resources: info.resources, settings: info.settings, endpoint: state.endpoint };
}
export function parseIdeArgs(args) {
  const options = { action: args[0] && !args[0].startsWith('--') ? args.shift() : 'check' };
  const flags = { '--resources': 'resources', '--settings': 'settings', '--port': 'port', '--proxy-url': 'proxyUrl', '--data-dir': 'dataDir', '--executable': 'executable' };
  if (!['check', 'apply', 'restore', 'status', 'launch'].includes(options.action)) fail('INVALID_ARGUMENT', 'Use ide check|apply|restore|status|launch.');
  for (let i = 0; i < args.length; i++) {
    if (!flags[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENT', `Unknown or missing argument: ${args[i]}`);
    options[flags[args[i]]] = args[++i];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseIdeArgs(process.argv.slice(2));
    const result = options.action === 'launch' ? await launchIde(options) : configureIde(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
