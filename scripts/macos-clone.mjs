#!/usr/bin/env node
// macOS only: copy the official Antigravity.app, patch the copy, and re-sign it ad hoc.
// The official app is only read. The copy carries a local ad-hoc signature, not Google's signature or notarization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';
import { deploy, walk } from './deploy.mjs';

const DEFAULT_SOURCE = '/Applications/Antigravity.app';
const DEFAULT_TARGET = path.join(os.homedir(), 'Applications', 'Antigravity (add-model).app');
const BUNDLE_ID_SUFFIX = '.addmodel';
const ASAR_INTEGRITY_KEY = 'Resources/app.asar';
const MACHO_MAGIC = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);
const exec = promisify(execFile);

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
async function run(command, args) {
  try {
    const { stdout, stderr } = await exec(command, args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
}
async function plutil(args) {
  const result = await run('plutil', args);
  if (!result.ok) fail('PLIST_FAILED', result.stderr.trim());
  return result.stdout;
}
// macOS-only tools sit behind these operations so tests can replace them.
const systemOperations = {
  codesign: (args) => run('codesign', args),
  readPlist: async (file) => JSON.parse(await plutil(['-convert', 'json', '-o', '-', file])),
  setPlistValue: (file, key, value) => plutil(['-replace', key, '-json', JSON.stringify(value), file]),
  patch: (resources, userDataDir) => deploy({ resources, userDataDir }),
};

const inside = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep);
// realpath for a path that may not exist yet: resolve the deepest existing ancestor, then re-append the rest.
function resolveFuture(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(resolveFuture(path.dirname(target)), path.basename(target));
  }
}
function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.toString('hex'));
  } finally {
    fs.closeSync(fd);
  }
}
// Items to sign, innermost first, the bundle itself last: nested .app/.framework bundles and standalone Mach-O files.
// A bundle's main executable is covered by the bundle's own signature, so it is skipped.
export function codeItems(app) {
  const items = [];
  const mainExecutables = new Set();
  const entries = walk(app);
  for (const { name, stat } of entries) {
    if (!stat.isDirectory()) continue;
    if (name.endsWith('.framework')) {
      items.push(name);
      const versions = path.join(app, name, 'Versions');
      if (exists(versions))
        for (const version of fs.readdirSync(versions))
          mainExecutables.add(`${name}/Versions/${version}/${path.posix.basename(name, '.framework')}`);
    } else if (name.endsWith('.app')) items.push(name);
  }
  for (const { name, stat } of entries) {
    if (!stat.isFile() || mainExecutables.has(name) || /(^|\/)Contents\/MacOS\/[^/]+$/.test(name)) continue;
    if (isMachO(path.join(app, name))) items.push(name);
  }
  items.sort((a, b) => b.split('/').length - a.split('/').length);
  return [...items, ''];
}

/** Copy `source` to `target`, patch the copy, and re-sign it ad hoc. `source` is never written to. */
export async function cloneMacApp(options = {}, operations = {}) {
  const ops = { ...systemOperations, ...operations };
  const sourceInput = path.resolve(options.source ?? DEFAULT_SOURCE);
  if (!exists(path.join(sourceInput, 'Contents', 'Info.plist')))
    fail('APP_NOT_FOUND', `Expected a macOS .app bundle with Contents/Info.plist: ${sourceInput}`);
  const source = fs.realpathSync(sourceInput);
  const target = resolveFuture(path.resolve(options.target ?? DEFAULT_TARGET));
  if (!target.endsWith('.app')) fail('UNSAFE_DESTINATION', `The destination must end with .app: ${target}`);
  if (inside(source, target) || inside(target, source))
    fail(
      'UNSAFE_DESTINATION',
      `The destination must be separate from the official app, which is never modified: ${target}`,
    );
  // Only replace a previous clone of this tool, never an arbitrary app.
  if (exists(target)) {
    const previousInfo = path.join(target, 'Contents', 'Info.plist');
    if (!exists(previousInfo) || !(await ops.readPlist(previousInfo)).CFBundleIdentifier?.endsWith(BUNDLE_ID_SUFFIX))
      fail(
        'DESTINATION_NOT_CLONE',
        `Refusing to replace something that is not a clone made by this command: ${target}`,
      );
  }

  const sourceInfo = await ops.readPlist(path.join(source, 'Contents', 'Info.plist'));
  const bundleId = sourceInfo.CFBundleIdentifier + BUNDLE_ID_SUFFIX;
  // The clone gets its own profile so it shares neither data nor the single-instance lock with the official app.
  const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', path.basename(target, '.app'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.add-model-staging-'));
  try {
    const clone = path.join(staging, path.basename(target));
    fs.cpSync(source, clone, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    // cpSync applies the current umask (for example 755 becomes 700 under umask 077). Restore the original modes.
    fs.chmodSync(clone, fs.statSync(source).mode & 0o777);
    for (const { name, stat } of walk(source)) {
      if (!stat.isSymbolicLink()) fs.chmodSync(path.join(clone, name), stat.mode & 0o777);
    }

    const resources = path.join(clone, 'Contents', 'Resources');
    await ops.patch(resources, userDataDir);
    // The official app is the backup; keep restore data out of the sealed bundle.
    fs.rmSync(path.join(resources, '.antigravity-model-patch'), { recursive: true, force: true });

    const infoFile = path.join(clone, 'Contents', 'Info.plist');
    await ops.setPlistValue(infoFile, 'CFBundleIdentifier', bundleId);
    const integrity = sourceInfo.ElectronAsarIntegrity;
    if (integrity?.[ASAR_INTEGRITY_KEY]) {
      const archive = path.join(resources, 'app.asar');
      asar.uncache(archive);
      const hash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
      await ops.setPlistValue(infoFile, 'ElectronAsarIntegrity', {
        ...integrity,
        [ASAR_INTEGRITY_KEY]: { ...integrity[ASAR_INTEGRITY_KEY], hash },
      });
    }

    // Re-sign inside-out, keeping each item's original entitlements.
    const scratch = path.join(staging, 'entitlements');
    fs.mkdirSync(scratch);
    for (const [index, item] of codeItems(clone).entries()) {
      const original = await ops.codesign(['-d', '--entitlements', '-', '--xml', path.join(source, item)]);
      const args = ['--force', '--sign', '-', '--timestamp=none'];
      if (original.ok && original.stdout.trim().startsWith('<')) {
        const file = path.join(scratch, `${index}.plist`);
        fs.writeFileSync(file, original.stdout);
        args.push('--entitlements', file);
      }
      const signed = await ops.codesign([...args, path.join(clone, item)]);
      if (!signed.ok) fail('SIGN_FAILED', `${item || '.'}: ${signed.stderr.trim()}`);
    }
    const verified = await ops.codesign(['--verify', '--deep', '--strict', clone]);
    if (!verified.ok) fail('SIGNATURE_INVALID', verified.stderr.trim());

    const previous = path.join(staging, 'previous');
    if (exists(target)) fs.renameSync(target, previous);
    try {
      fs.renameSync(clone, target);
    } catch (error) {
      if (exists(previous)) fs.renameSync(previous, target);
      throw error;
    }
    return { source, target, bundleId, version: sourceInfo.CFBundleShortVersionString };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const USAGE = 'Usage: node scripts/macos-clone.mjs [--source APP] [--target APP]';
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source' || arg === '--target') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('USAGE', `${arg} requires a path.`);
      options[arg.slice(2)] = argv[++index];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else fail('USAGE', `Unknown argument: ${arg}\n${USAGE}`);
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        `${USAGE}\nCopies the official app (default ${DEFAULT_SOURCE}) to ${DEFAULT_TARGET}, patches only the copy and re-signs it ad hoc.\nRun it again after an official update to rebuild the copy.`,
      );
    else {
      if (process.platform !== 'darwin') fail('UNSUPPORTED_PLATFORM', 'This command only supports macOS.');
      const result = await cloneMacApp(options);
      console.log(`CLONE READY: Antigravity ${result.version} at ${result.target}`);
      console.log(`Bundle identifier: ${result.bundleId}`);
      console.log(`The official app was not modified: ${result.source}`);
      console.log(
        'The clone is signed locally (ad hoc), not by Google, and is not notarized. Open it once to confirm it works.',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
