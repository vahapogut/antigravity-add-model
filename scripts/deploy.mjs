#!/usr/bin/env node
// Patch a recognized standalone app without executing vendor code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';
import { planRuntimePatch } from './runtime-patch.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = '.antigravity-model-patch';
const ISSUE = 'https://github.com/vahapogut/antigravity-add-model/issues/2';
const HASH = /^[a-f0-9]{64}$/;
const ORIGINAL_URL = Buffer.from('https://daily-cloudcode-pa.googleapis.com');
const PATCHED_URL = Buffer.from('http://localhost:50999/v1internal/xxxxxxx');
export const REQUIRED_BUILD_FILES = [
  'desktop.js',
  'customPreload.js',
  'customIpc.js',
  'modelStore.js',
  'modelManagement.js',
  'modelActions.js',
  'modelIdentity.js',
  'diagnostics.js',
  'generationProbe.js',
  'googleAccounts.js',
  'googlePoolPolicy.js',
  'googleOAuth.js',
  'googleNativeClient.js',
  'googleOnboarding.js',
  'googleAccessErrors.js',
  'providers.js',
  'proxy.js',
  'cryptoStore.js',
  'schemaValidator.js',
  'proxy/registry.js',
  'proxy/shared.js',
  'proxy/customRequest.js',
  'proxy/subagentRouting.js',
  'proxy/subagentModels.js',
  'proxy/nativeSubagentResponse.js',
  'proxy/requestOptions.js',
  'proxy/circuitBreaker.js',
  'proxy/translators/openai.js',
  'proxy/translators/anthropic.js',
  'proxy/translators/google.js',
  'proxy/translators/ollama.js',
  'proxy/listen.js',
  'proxy/loopbackSecurity.js',
  'proxy/modelUtils.js',
  'proxy/modelCatalog.js',
  'proxy/cloudCodeRouting.js',
  'proxy/translators/utils.js',
  'proxy/translators/images.js',
  'proxy/googlePoolFailover.js',
];

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function extractFile(archive, name) {
  return asar.extractFile(archive, path.normalize(name));
}
function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('UNSAFE_PATH', `Path is outside the expected directory: ${target}`);
  }
}
// Do not traverse links/junctions while writing or recursively removing files.
function assertNoLinks(root, target) {
  assertInside(root, target);
  let current = path.resolve(root);
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail('UNSAFE_PATH', `Refusing a symlink in an installation path: ${current}`);
    }
  }
}
function removeOwned(root, target) {
  assertNoLinks(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}
function hashFile(filename) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
function walk(root, relative = '') {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const item = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, item));
    result.push({ name: item, stat });
    if (stat.isDirectory()) result.push(...walk(root, item));
  }
  return result;
}
function hashDirectory(directory) {
  if (!exists(directory)) return null;
  // macOS may expose /private/var through /var, and user-supplied parent paths
  // may have aliases too. Compare resolved link targets to a resolved root.
  const canonicalDirectory = fs.realpathSync(directory);
  const hash = createHash('sha256');
  for (const { name, stat } of walk(directory)) {
    const filename = path.join(directory, name);
    const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file';
    if (kind === 'link') {
      const link = fs.readlinkSync(filename);
      if (path.isAbsolute(link)) fail('UNSAFE_PATH', `Unpacked absolute links cannot be relocated safely: ${filename}`);
      assertInside(directory, path.resolve(path.dirname(filename), link));
      try {
        assertInside(canonicalDirectory, fs.realpathSync(filename));
      } catch {
        fail('UNSAFE_PATH', `Unpacked link must resolve inside its own directory: ${filename}`);
      }
      hash.update(JSON.stringify([name, kind, link]));
    } else if (kind === 'file') {
      if (!stat.isFile()) fail('UNSUPPORTED_FILE', `Unsupported file: ${filename}`);
      hash.update(JSON.stringify([name, kind, stat.mode & 0o777, hashFile(filename)]));
    } else hash.update(JSON.stringify([name, kind, stat.mode & 0o777]));
  }
  return hash.digest('hex');
}
function locations(resources) {
  return {
    archive: path.join(resources, 'app.asar'),
    unpacked: path.join(resources, 'app.asar.unpacked'),
    binary: path.join(resources, 'bin', 'language_server.exe'),
  };
}
export function fingerprint(resources) {
  const files = locations(resources);
  for (const filename of Object.values(files)) assertNoLinks(resources, filename);
  return {
    archive: hashFile(files.archive),
    unpacked: hashDirectory(files.unpacked),
    binary: exists(files.binary) ? hashFile(files.binary) : null,
  };
}
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function backupId(version, original) {
  const slug =
    String(version)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 50) || 'unknown';
  return `v-${slug}-${createHash('sha256').update(JSON.stringify(original)).digest('hex')}`;
}
export function resolveResources(input, platform = process.platform, env = process.env) {
  const candidates = input
    ? [path.resolve(input), path.resolve(input, 'Contents', 'Resources'), path.resolve(input, 'resources')]
    : platform === 'darwin'
      ? [
          '/Applications/Antigravity.app/Contents/Resources',
          path.join(os.homedir(), 'Applications/Antigravity.app/Contents/Resources'),
          '/Applications/Antigravity IDE.app/Contents/Resources',
        ]
      : platform === 'win32'
        ? [
            path.join(env.LOCALAPPDATA || os.homedir(), 'Programs/antigravity/resources'),
            path.join(env.LOCALAPPDATA || os.homedir(), 'Programs/Antigravity IDE/resources'),
          ]
        : [
            path.join(os.homedir(), '.local/share/Programs/antigravity/resources'),
            '/opt/antigravity/resources',
            '/usr/lib/antigravity/resources',
            '/usr/local/lib/antigravity/resources',
          ];
  for (const candidate of candidates) {
    if (exists(path.join(candidate, 'app.asar')) || exists(path.join(candidate, 'app', 'out')))
      return fs.realpathSync(candidate);
  }
  fail('APP_NOT_FOUND', `No Antigravity app.asar found. Pass --resources PATH. Checked: ${candidates.join(', ')}`);
}
function unsupported() {
  fail(
    'NOT_SUPPORTED',
    `The VS Code-based Antigravity IDE (app/out) needs a separate adapter. This patch supports the standalone Electron app only. Copying dist into the IDE does not activate it. ${ISSUE}`,
  );
}
function archiveEntries(archive) {
  asar.uncache(archive);
  return asar.listPackage(archive).map((item) => {
    const name = item.replaceAll('\\', '/').replace(/^\//, '');
    if (!name || name.split('/').some((part) => !part || part === '..' || part === '.') || /[:\0]/.test(name)) {
      fail('UNSAFE_ARCHIVE', `Invalid archive member: ${name}`);
    }
    const entry = asar.statFile(archive, path.normalize(name), false);
    if ('link' in entry) {
      if (path.posix.isAbsolute(entry.link) || entry.link.split(/[\\/]/).includes('..'))
        fail('UNSAFE_ARCHIVE', `Archive link escapes the package: ${name}`);
      if (name === 'dist' || name.startsWith('dist/'))
        fail('UNSUPPORTED_LAYOUT', `Patch destination is a link: ${name}`);
    }
    return { name, entry };
  });
}
function inspectArchive(archive) {
  const entries = archiveEntries(archive);
  let pkg;
  try {
    pkg = JSON.parse(extractFile(archive, 'package.json').toString());
  } catch {
    fail('UNSUPPORTED_LAYOUT', 'The installed archive has no readable package.json.');
  }
  const main = String(pkg.main || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  if (main.startsWith('out/') || entries.some(({ name }) => name === 'out/vs/workbench/workbench.desktop.main.js'))
    unsupported();
  if (
    main !== 'dist/main.js' ||
    !entries.some(({ name, entry }) => name === 'dist/preload.js' && !('files' in entry))
  ) {
    fail('UNSUPPORTED_LAYOUT', 'Expected standalone package main=dist/main.js and dist/preload.js. No files changed.');
  }
  extractFile(archive, 'dist/main.js');
  return { version: String(pkg.version || 'unknown'), entries };
}
function readState(resources) {
  const filename = path.join(resources, STATE_DIR, 'state.json');
  assertNoLinks(resources, filename);
  if (!exists(filename)) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    fail('INVALID_STATE', `Cannot read ${filename}; the app was not changed.`);
  }
  const validSnapshot = (value) =>
    value &&
    HASH.test(value.archive) &&
    (value.unpacked === null || HASH.test(value.unpacked)) &&
    (value.binary === null || HASH.test(value.binary));
  if (
    state.schema !== 1 ||
    typeof state.version !== 'string' ||
    !validSnapshot(state.original) ||
    !validSnapshot(state.patched) ||
    state.backupId !== backupId(state.version, state.original)
  ) {
    fail('INVALID_STATE', 'Patch state failed validation. Refusing to use a backup path from invalid state.');
  }
  return state;
}
function binaryPlan(resources, requested) {
  const binary = locations(resources).binary;
  if (!exists(binary)) {
    if (requested) fail('BINARY_NOT_FOUND', '--patch-language-server requires resources/bin/language_server.exe.');
    return { mode: 'unknown', bytes: null };
  }
  const bytes = fs.readFileSync(binary);
  const originalFound = bytes.includes(ORIGINAL_URL);
  const patchedFound = bytes.includes(PATCHED_URL);
  if (requested) {
    if (
      bytes[0] !== 0x4d ||
      bytes[1] !== 0x5a ||
      ORIGINAL_URL.length !== PATCHED_URL.length ||
      (!originalFound && !patchedFound)
    ) {
      fail(
        'BINARY_NOT_SUPPORTED',
        'Expected a Windows PE language server with the recognized Cloud Code endpoint. No binary was changed.',
      );
    }
    if (originalFound) {
      let offset = 0;
      while ((offset = bytes.indexOf(ORIGINAL_URL, offset)) !== -1) {
        PATCHED_URL.copy(bytes, offset);
        offset += PATCHED_URL.length;
      }
      return { mode: 'fixed', bytes };
    }
  }
  return { mode: patchedFound ? 'fixed' : originalFound ? 'dynamic' : 'unknown', bytes: null };
}
export function preflight(options = {}) {
  const resources = resolveResources(options.resources, options.platform, options.env);
  if (exists(path.join(resources, 'app', 'out'))) unsupported();
  const files = locations(resources);
  for (const filename of Object.values(files)) assertNoLinks(resources, filename);
  let info = inspectArchive(files.archive);
  const state = readState(resources);
  const current = fingerprint(resources);
  const dist = path.resolve(options.dist || path.join(PROJECT, 'dist'));
  let vendorFiles = files;
  let runtimePatch;
  if (!options.restore) {
    for (const item of REQUIRED_BUILD_FILES) {
      const filename = path.join(dist, item);
      if (!exists(filename) || !fs.statSync(filename).isFile() || fs.statSync(filename).size === 0)
        fail('BUILD_MISSING', `Missing compiled patch ${filename}. Run npm ci and npm run build first.`);
    }
    if (walk(dist).some(({ stat }) => stat.isSymbolicLink()))
      fail('UNSAFE_BUILD', 'Compiled dist must not contain symlinks.');
    // A repeated installation (including upgrades from the old overlay installer)
    // must start from the verified original for THIS exact installed version.
    // Never compose hooks on already patched files or reuse a stale legacy backup.
    if (state && equal(state.patched, current)) {
      vendorFiles = locations(verifyBackup(resources, state));
      info = inspectArchive(vendorFiles.archive);
    }
    runtimePatch = planRuntimePatch(
      (name) => extractFile(vendorFiles.archive, name),
      (name) => fs.readFileSync(path.join(dist, name)),
    );
  }
  const plan = options.restore ? null : binaryPlan(resources, options.patchLanguageServer);
  if (options.restore && (!state || !equal(state.patched, current))) {
    fail(
      'RESTORE_REFUSED',
      'The current app does not match this installer’s last patched archive, unpacked files, and binary. An app update or external change must not be overwritten.',
    );
  }
  return { resources, files, ...info, state, current, dist, plan, vendorFiles, runtimePatch };
}
function copyIfPresent(source, destination) {
  if (exists(source))
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
function copyInstallation(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const from = locations(source);
  const to = locations(destination);
  for (const key of Object.keys(from)) copyIfPresent(from[key], to[key]);
}
function verifyBackup(resources, state) {
  const backup = path.join(resources, STATE_DIR, 'backups', state.backupId);
  assertNoLinks(resources, backup);
  if (!exists(locations(backup).archive) || !equal(fingerprint(backup), state.original))
    fail('BACKUP_INVALID', `The saved original backup failed its SHA-256 check: ${backup}`);
  return backup;
}
/** Read-only update recovery inspection; does not require a compiled addon. */
export function inspectForUpdate(options = {}) {
  const resources = resolveResources(options.resources, options.platform, options.env);
  if (exists(path.join(resources, 'app', 'out'))) unsupported();
  for (const filename of Object.values(locations(resources))) assertNoLinks(resources, filename);
  const info = inspectArchive(locations(resources).archive);
  const state = readState(resources);
  const current = fingerprint(resources);
  if (state && !equal(state.patched, current)) {
    fail('RESTORE_REFUSED', 'This installation changed after patching, possibly during an update. Do not restore an older backup over it.');
  }
  if (state) verifyBackup(resources, state);
  return { resources, version: info.version, status: state ? 'managed' : 'unmanaged' };
}
export async function packPreservingUnpacked(source, candidate, originalEntries) {
  const original = new Map(originalEntries.map(({ name, entry }) => [name, entry]));
  const streams = walk(source).map(({ name, stat }) => {
    const before = original.get(name);
    let unpacked = Boolean(before?.unpacked);
    for (
      let ancestor = path.posix.dirname(name);
      !unpacked && ancestor !== '.';
      ancestor = path.posix.dirname(ancestor)
    ) {
      unpacked = Boolean(original.get(ancestor)?.unpacked);
    }
    if (stat.isDirectory()) return { type: 'directory', path: name, unpacked };
    const streamGenerator = () => fs.createReadStream(path.join(source, name));
    if (before && 'link' in before)
      return {
        type: 'link',
        path: name,
        unpacked,
        stat,
        streamGenerator,
        symlink: path.posix.relative(path.posix.dirname(name), before.link.replaceAll('\\', '/')),
      };
    if (stat.isSymbolicLink())
      return {
        type: 'link',
        path: name,
        unpacked,
        stat,
        streamGenerator,
        symlink: fs.readlinkSync(path.join(source, name)),
      };
    return { type: 'file', path: name, unpacked, stat, streamGenerator };
  });
  await asar.createPackageFromStreams(candidate, streams);
}
function copyMissingUnpacked(source, destination) {
  if (!exists(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const { name, stat } of walk(source)) {
    const target = path.join(destination, name);
    if (exists(target)) continue;
    assertNoLinks(destination, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isDirectory()) fs.mkdirSync(target, { mode: stat.mode & 0o777 });
    else if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(path.join(source, name)), target);
    else {
      fs.copyFileSync(path.join(source, name), target);
      fs.chmodSync(target, stat.mode & 0o777);
    }
  }
}
async function packCandidate(source, candidate, entries) {
  const plan = path.join(path.dirname(source), 'unpacked-plan.json');
  fs.writeFileSync(plan, JSON.stringify(entries));
  // ASAR 4.3's stream packer hashes relative paths from cwd. Isolate packing in
  // a child with cwd=source so its integrity hashes match the bytes it writes.
  // Only our installer and pinned packaging library run; vendor JS is never loaded.
  const script = `import fs from 'node:fs'; import {packPreservingUnpacked} from ${JSON.stringify(import.meta.url)}; await packPreservingUnpacked(process.argv[1], process.argv[2], JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, source, candidate, plan], {
    cwd: source,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}
function verifyArchiveIntegrity(archive) {
  for (const { name, entry } of archiveEntries(archive)) {
    if ('files' in entry || 'link' in entry) continue;
    const bytes = extractFile(archive, name);
    if (bytes.length !== entry.size || entry.integrity?.hash !== createHash('sha256').update(bytes).digest('hex')) {
      fail('PACK_INVALID', `Archive integrity validation failed: ${name}`);
    }
  }
}
// Current archive, unpacked files, binary, and state participate in one reversible swap.
function swapTransaction(resources, staging, replacements, rename = fs.renameSync) {
  const steps = [];
  try {
    for (let index = 0; index < replacements.length; index++) {
      const { target, candidate } = replacements[index];
      assertNoLinks(resources, target);
      const previous = path.join(staging, `rollback-${index}`);
      const step = { target, previous, moved: false, installed: false };
      steps.push(step);
      if (exists(target)) {
        rename(target, previous);
        step.moved = true;
      }
      if (candidate && exists(candidate)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        rename(candidate, target);
        step.installed = true;
      }
    }
  } catch (error) {
    try {
      for (const step of steps.reverse()) {
        if (step.installed) removeOwned(resources, step.target);
        if (step.moved) fs.renameSync(step.previous, step.target);
      }
    } catch (rollbackError) {
      const failure = new Error(
        `ROLLBACK_REQUIRED: ${rollbackError.message}. Original files are retained in ${staging}. Initial error: ${error.message}`,
      );
      failure.keepStaging = true;
      throw failure;
    }
    throw error;
  }
}
export async function deploy(options = {}, operations = {}) {
  const info = preflight(options);
  if (options.check)
    return { action: 'check', resources: info.resources, version: info.version, binaryMode: info.plan?.mode };
  const { resources, files, state, current } = info;
  const meta = path.join(resources, STATE_DIR);
  assertNoLinks(resources, meta);
  fs.mkdirSync(meta, { recursive: true });
  const lock = path.join(meta, 'deploy.lock');
  let lockFd;
  try {
    lockFd = fs.openSync(lock, 'wx');
  } catch {
    fail('DEPLOY_LOCKED', `Another deployment or an interrupted run owns ${lock}. Inspect it before retrying.`);
  }
  fs.writeFileSync(lockFd, `pid=${process.pid}\n`);
  let staging;
  let keepStaging = false;
  let originalBackup;
  try {
    if (!equal(fingerprint(resources), current))
      fail('APP_CHANGED', 'The app changed during preflight. Close Antigravity and retry.');
    staging = fs.mkdtempSync(path.join(resources, '.antigravity-patch-'));
    const candidateRoot = path.join(staging, 'candidate');
    const candidate = locations(candidateRoot);
    fs.mkdirSync(candidateRoot);
    let nextState = null;
    if (options.restore) {
      originalBackup = verifyBackup(resources, state);
      copyInstallation(originalBackup, candidateRoot);
      if (!equal(fingerprint(candidateRoot), state.original))
        fail('BACKUP_INVALID', 'The prepared restore does not match the original backup.');
    } else {
      const source = path.join(staging, 'source');
      // Preserve the installed vendor runtime. Our modules live in their own
      // directory; only three validated integration hooks change vendor files.
      asar.extractAll(info.vendorFiles.archive, source);
      for (const file of REQUIRED_BUILD_FILES) {
        const target = path.join(source, 'dist', 'modelPatch', file);
        assertNoLinks(source, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(info.dist, file), target);
      }
      for (const [name, contents] of info.runtimePatch) {
        const target = path.join(source, name);
        assertNoLinks(source, target);
        fs.writeFileSync(target, contents);
      }
      const marker = path.join(source, 'antigravity-proxy.json');
      if (info.plan.mode === 'fixed') fs.writeFileSync(marker, JSON.stringify({ requiredPort: 50999 }) + '\n');
      if (info.plan.mode === 'dynamic' && exists(marker)) removeOwned(source, marker);
      // Rebuild referenced unpacked entries cleanly; then preserve unlisted vendor
      // extras without overwriting newly generated files or following live links.
      await (operations.pack || packCandidate)(source, candidate.archive, info.entries);
      copyMissingUnpacked(info.vendorFiles.unpacked, candidate.unpacked);
      fs.chmodSync(candidate.archive, fs.statSync(files.archive).mode & 0o777);
      inspectArchive(candidate.archive);
      verifyArchiveIntegrity(candidate.archive);
      for (const file of REQUIRED_BUILD_FILES) {
        if (
          !extractFile(candidate.archive, `dist/modelPatch/${file}`).equals(fs.readFileSync(path.join(info.dist, file)))
        )
          fail('PACK_INVALID', `Packaged patch does not match the build: ${file}`);
      }
      for (const [name, contents] of info.runtimePatch) {
        if (!extractFile(candidate.archive, name).equals(contents))
          fail('PACK_INVALID', `Packaged runtime hook does not match preflight: ${name}`);
      }
      copyIfPresent(files.binary, candidate.binary);
      if (info.plan.bytes) {
        fs.writeFileSync(candidate.binary, info.plan.bytes);
        fs.chmodSync(candidate.binary, fs.statSync(files.binary).mode & 0o777);
      }
      const repeated = state && equal(state.patched, current);
      const original = repeated ? state.original : current;
      const version = repeated ? state.version : info.version;
      nextState = {
        schema: 1,
        version,
        backupId: backupId(version, original),
        original,
        patched: fingerprint(candidateRoot),
      };
      originalBackup = path.join(meta, 'backups', nextState.backupId);
      assertNoLinks(resources, originalBackup);
      if (repeated || exists(originalBackup)) verifyBackup(resources, nextState);
      else {
        const backupCandidate = path.join(staging, 'original');
        copyInstallation(resources, backupCandidate);
        if (!equal(fingerprint(backupCandidate), current))
          fail('APP_CHANGED', 'The app changed while its original backup was being prepared.');
        fs.mkdirSync(path.dirname(originalBackup), { recursive: true });
        fs.renameSync(backupCandidate, originalBackup);
      }
    }
    if (!equal(fingerprint(resources), current))
      fail('APP_CHANGED', 'The installed app changed during packaging. No candidate was installed.');
    const stateCandidate = path.join(staging, 'state.json');
    if (nextState) fs.writeFileSync(stateCandidate, JSON.stringify(nextState, null, 2) + '\n');
    const replacements = [
      { target: files.archive, candidate: candidate.archive },
      { target: files.unpacked, candidate: candidate.unpacked },
    ];
    // Fingerprint/backup the binary always; replace it only for an explicit patch or restore.
    if (options.restore || info.plan?.bytes) replacements.push({ target: files.binary, candidate: candidate.binary });
    replacements.push({ target: path.join(meta, 'state.json'), candidate: nextState ? stateCandidate : null });
    swapTransaction(resources, staging, replacements, operations.rename);
    asar.uncache(files.archive);
    return {
      action: options.restore ? 'restore' : 'apply',
      resources,
      version: info.version,
      binaryMode: info.plan?.mode,
      backup: originalBackup,
    };
  } catch (error) {
    keepStaging = Boolean(error.keepStaging);
    throw error;
  } finally {
    fs.closeSync(lockFd);
    if (staging && !keepStaging) removeOwned(resources, staging);
    if (!keepStaging) removeOwned(resources, lock);
  }
}
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--resources') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('USAGE', '--resources requires a path.');
      options.resources = argv[++index];
    } else if (arg === '--check') options.check = true;
    else if (arg === '--restore') options.restore = true;
    else if (arg === '--patch-language-server') options.patchLanguageServer = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail('USAGE', `Unknown argument: ${arg}`);
  }
  if ((options.check && options.restore) || (options.restore && options.patchLanguageServer))
    fail('USAGE', '--check/--restore and --restore/--patch-language-server cannot be combined.');
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        'Usage: node scripts/deploy.mjs [--resources PATH] [--check|--restore] [--patch-language-server]\nClose Antigravity before applying/restoring; reopen it manually afterward.',
      );
    else {
      if (!options.check)
        console.log('Close Antigravity before deploying. This installer does not stop or launch applications.');
      const result = await deploy(options);
      console.log(
        `${result.action === 'check' ? 'CHECK PASSED (no files changed)' : result.action === 'restore' ? 'RESTORED' : 'PATCH INSTALLED'}: standalone ${result.version} at ${result.resources}`,
      );
      if (result.backup) console.log(`Original backup: ${result.backup}`);
      if (result.binaryMode === 'fixed')
        console.log('The recognized language-server endpoint requires local proxy port 50999.');
      if (!options.check)
        console.log('Reopen Antigravity manually. Runtime behavior still needs verification in the app.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
