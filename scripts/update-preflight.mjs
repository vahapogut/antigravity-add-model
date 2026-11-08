#!/usr/bin/env node
/** Windows update diagnostics and explicit, verified addon recovery. Never kill app processes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveResources, inspectForUpdate, deploy } from './deploy.mjs';
import { configureIde } from './ide.mjs';
import { serviceCommand } from './desktop-service.mjs';

const exec = promisify(execFile);
const usage = 'Use update-preflight.mjs check|prepare --resources PATH [--settings FILE] [--data-dir DIR] [--json]';
const candidateName = /^(?:antigravity(?: ide)?|language_server(?:_[a-z0-9_]+)?)\.exe$/i;
const mutexName = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }

export function parseUpdateArgs(args) {
  const options = { command: args[0] || 'check' };
  if (!['check', 'prepare'].includes(options.command)) fail('USAGE', usage);
  const flags = { '--resources': 'resources', '--settings': 'settings', '--data-dir': 'dataDirectory' };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (flags[arg] && args[i + 1] && !args[i + 1].startsWith('--')) options[flags[arg]] = path.resolve(args[++i]);
    else fail('USAGE', usage);
  }
  if (!options.resources) fail('USAGE', `Pass the exact installation path with --resources. ${usage}`);
  return options;
}

function noLinks(filename) {
  const resolved = path.resolve(filename);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', `Refusing linked installation path: ${current}`);
  }
}

export function inspectUpdateInstallation(options) {
  if (!options.resources) fail('USAGE', 'An explicit --resources installation path is required.');
  noLinks(options.resources);
  const resources = resolveResources(options.resources, options.platform, options.env);
  noLinks(resources);
  const installation = fs.realpathSync(path.dirname(resources));
  if (fs.existsSync(path.join(resources, 'app', 'out'))) {
    const report = configureIde({ ...options, resources, action: 'status' });
    if (report.status === 'conflict') fail('RESTORE_REFUSED', 'The managed IDE endpoint was changed outside this adapter. Resolve that settings conflict before preparation.');
    const metadata = path.join(resources, 'app', 'product.json');
    noLinks(metadata);
    if (fs.statSync(metadata).size > 1024 * 1024) fail('MUTEX_METADATA_INVALID', 'IDE product metadata is oversized. No mutex names were guessed.');
    const product = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (typeof product.win32MutexName !== 'string' || !mutexName.test(product.win32MutexName))
      fail('MUTEX_METADATA_INVALID', 'IDE product metadata has no valid win32MutexName. No mutex names were guessed.');
    // These names come from the vendor runtime's installMutex, checkInnoSetupMutex,
    // and Windows background-update readiness check. Do not infer names from an exe.
    const mutexNames = [product.win32MutexName, `${product.win32MutexName}setup`, `${product.win32MutexName}-ready`];
    return { kind: 'ide', installation, resources, version: report.ideVersion || report.version,
      settings: report.settings, status: report.applied ? 'managed' : 'unmanaged', mutexNames };
  }
  const report = inspectForUpdate({ ...options, resources });
  return { kind: 'standalone', installation, ...report };
}

function validateMutexProbe(names, items) {
  if (!Array.isArray(items) || items.length !== names.length || !items.every((item, index) =>
    item?.name === names[index] && ['present', 'absent', 'unverifiable'].includes(item.status) &&
    (item.status === 'unverifiable'
      ? Number.isInteger(item.errorCode) && item.errorCode >= 0
      : item.errorCode === undefined))) {
    fail('MUTEX_CHECK_UNAVAILABLE', 'Windows mutex inspection returned an invalid or incomplete result.');
  }
  return items.map(({ name, status, errorCode }) => ({ name, status, ...(errorCode === undefined ? {} : { errorCode }) }));
}

/** Read existing named objects without creating, acquiring or releasing any mutex. */
export async function probeWindowsMutexes(names, options = {}) {
  if ((options.platform || process.platform) !== 'win32') fail('MUTEX_CHECK_UNAVAILABLE', 'Automatic mutex checks are Windows-only.');
  if (!Array.isArray(names) || names.length < 1 || names.length > 3 ||
      names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,133}$/i.test(name)) || new Set(names).size !== names.length)
    fail('MUTEX_METADATA_INVALID', 'Refusing invalid or duplicate mutex names.');
  const systemRoot = options.env?.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Names are validated above, including exclusion of quotes and PowerShell syntax.
  // ERROR_FILE_NOT_FOUND is the only absence result; access denied and unexpected
  // object types remain unverifiable. SYNCHRONIZE requests no mutation rights.
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AntigravityUpdateMutexProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr OpenMutexW(uint access, bool inheritHandle, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@;
$results = @(foreach ($mutexName in @(${names.map(name => `'${name}'`).join(',')})) {
  $handle = [AntigravityUpdateMutexProbe]::OpenMutexW(0x00100000, $false, $mutexName);
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error();
  if ($handle -ne [IntPtr]::Zero) {
    try { @{name=$mutexName; status='present'} } finally {
      if (-not [AntigravityUpdateMutexProbe]::CloseHandle($handle)) { throw 'Could not close the diagnostic mutex handle.' }
    }
  } elseif ($errorCode -eq 2) { @{name=$mutexName; status='absent'} }
  else { @{name=$mutexName; status='unverifiable'; errorCode=$errorCode} }
});
ConvertTo-Json -InputObject $results -Compress`;
  try {
    // Add-Type compiles the C# above on every run, which can take well over 15 s on a busy machine.
    const { stdout } = await (options.exec || exec)(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    return validateMutexProbe(names, JSON.parse(stdout.replace(/^\ufeff/, '').trim()));
  } catch {
    fail('MUTEX_CHECK_UNAVAILABLE', 'Windows mutex inspection failed. No mutex was created, acquired or forcibly released.');
  }
}

async function inspectUpdateBlockers(installation, options, hooks) {
  const [processResult, mutexResult] = await Promise.allSettled([
    (async () => classifyUpdateProcesses(installation.installation, await (hooks.listProcesses || listWindowsProcesses)(options), options))(),
    installation.kind === 'ide'
      ? (async () => validateMutexProbe(installation.mutexNames,
          await (hooks.probeMutexes || probeWindowsMutexes)(installation.mutexNames, options)))()
      : Promise.resolve([]),
  ]);
  const processes = processResult.status === 'fulfilled' ? processResult.value : undefined;
  const processError = processResult.status === 'rejected' ? processResult.reason.message : undefined;
  const mutexes = mutexResult.status === 'rejected'
    ? { status: 'unavailable', items: [], error: mutexResult.reason.message }
    : { status: installation.kind === 'ide' ? 'checked' : 'not-applicable', items: mutexResult.value };
  const blocked = Boolean(processError || processes.matching.length || processes.otherInstallations.length || processes.unverifiable.length ||
    mutexes.status === 'unavailable' || mutexes.items.some(item => item.status !== 'absent'));
  return { processes, processError, mutexes, readyForPreparation: !blocked };
}

function requireNoBlockers(snapshot) {
  if (snapshot.readyForPreparation) return;
  const reason = snapshot.processError || snapshot.mutexes.error ||
    (snapshot.mutexes.items.some(item => item.status !== 'absent')
      ? 'An IDE or installer mutex is present or unverifiable. Close the app or finish/cancel the existing official installer normally; do not forcibly release its mutex.'
      : 'Close the listed app/language-server processes, including other installations that may hold a shared updater mutex; unknown executable identities must be resolved manually.');
  fail('PREPARE_BLOCKED', `${reason} Run update-preflight.mjs check --resources PATH --json for details. No files changed and no proxy was stopped.`);
}

/** Enumerate executable identity only; command lines may contain credentials. */
export async function listWindowsProcesses(options = {}) {
  if ((options.platform || process.platform) !== 'win32') fail('PROCESS_CHECK_UNAVAILABLE', 'Automatic process checks are Windows-only. No update preparation was performed.');
  const systemRoot = options.env?.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress";
  try {
    const { stdout } = await (options.exec || exec)(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    const result = JSON.parse(stdout.replace(/^\ufeff/, '').trim());
    const items = Array.isArray(result) ? result : result ? [result] : [];
    if (!items.every(item => Number.isInteger(item.ProcessId) && item.ProcessId >= 0 && typeof item.Name === 'string' && (item.ExecutablePath == null || typeof item.ExecutablePath === 'string'))) throw new Error('Invalid process response');
    return items.map(item => ({ pid: item.ProcessId, name: item.Name, executable: item.ExecutablePath || null }));
  } catch {
    fail('PROCESS_CHECK_UNAVAILABLE', 'Windows process inspection failed. Check PowerShell/CIM availability; close the app manually and collect the installer log. No processes were terminated.');
  }
}

export function classifyUpdateProcesses(installation, processes, options = {}) {
  const platform = options.platform || process.platform;
  const resolve = options.realpath || fs.realpathSync;
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value;
  const root = normalize(resolve(installation));
  const result = { matching: [], otherInstallations: [], unverifiable: [] };
  for (const processInfo of processes) {
    const { pid, name, executable } = processInfo;
    if (!Number.isInteger(pid) || typeof name !== 'string') fail('PROCESS_CHECK_UNAVAILABLE', 'Invalid process inventory.');
    if (!executable) {
      if (candidateName.test(name)) result.unverifiable.push({ pid, name });
      continue;
    }
    let canonical;
    try { canonical = resolve(executable); } catch {
      if (candidateName.test(name)) result.unverifiable.push({ pid, name });
      continue;
    }
    const relative = path.relative(root, normalize(canonical));
    const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (inside) result.matching.push({ pid, name, executable: canonical });
    else if (candidateName.test(name)) result.otherInstallations.push({ pid, name, executable: canonical });
  }
  return result;
}

export async function updatePreflight(options, hooks = {}) {
  const command = options.command || 'check';
  if (!['check', 'prepare'].includes(command)) fail('USAGE', usage);
  // Verify manifests, current files and backups before either restoration or service shutdown.
  const installation = inspectUpdateInstallation(options);
  const dataDirectory = path.resolve(options.dataDirectory || path.join(os.homedir(), '.gemini', 'antigravity'));
  const snapshot = await inspectUpdateBlockers(installation, options, hooks);
  const report = { command, installation, dataDirectory, ...snapshot, actions: [],
    guidance: 'This checks addon recovery, process identity and known IDE mutexes in the current Windows session, not every Windows file lock. If the official installer still fails, share the product/version, installer filename, this report and its installer log; redact personal paths and credentials.' };
  if (command === 'check') return report;
  requireNoBlockers(snapshot);
  // Re-inspect immediately before writing; adapters additionally check their own transaction state.
  const fresh = inspectUpdateInstallation(options);
  if (JSON.stringify(fresh) !== JSON.stringify(installation)) fail('INSTALLATION_CHANGED', 'Installation changed during inspection; retry.');
  // Backup verification can be slow. A restarted IDE or installer invalidates the
  // first snapshot, so check again after verification and immediately before writes.
  const freshSnapshot = await inspectUpdateBlockers(fresh, options, hooks);
  requireNoBlockers(freshSnapshot);
  Object.assign(report, freshSnapshot);
  if (installation.status === 'managed') {
    const result = installation.kind === 'ide'
      ? configureIde({ ...options, resources: installation.resources, settings: installation.settings, action: 'restore' })
      : await deploy({ ...options, resources: installation.resources, restore: true });
    report.actions.push({ action: 'restore', status: result.status || result.action });
  }
  // Shutdown uses an authenticated instance handshake, never PID/port-based termination.
  try {
    const stopped = await (hooks.serviceCommand || serviceCommand)({ command: 'stop', dataDirectory });
    report.actions.push({ action: 'proxy', status: stopped.status });
  } catch (error) {
    fail('PROXY_STOP_FAILED', `Managed restoration ${installation.status === 'managed' ? 'completed' : 'was not needed'}, but owned proxy shutdown failed: ${error.message}. No process was forcibly terminated.`);
  }
  report.guidance = (installation.status === 'managed'
    ? 'The verified managed changes were restored. '
    : 'No active managed restoration was available; no application or settings files were restored. Older untracked patches require separate recovery. ') +
    'The owned proxy is stopped. Run the official installer manually. After updating, recheck compatibility before applying the addon again. Models and saved credentials were preserved.';
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseUpdateArgs(process.argv.slice(2));
    const result = await updatePreflight(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.readyForPreparation) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
