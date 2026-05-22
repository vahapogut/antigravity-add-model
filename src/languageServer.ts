import { execFile, spawn, ChildProcess } from 'child_process';
import { app, session } from 'electron';
import { shellEnvSync } from 'shell-env';
import * as fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { PassThrough } from 'stream';
import { getLsLogPath, getAppDataDirName, getActivePortFilePath } from './paths';
import { LS_CERT_FINGERPRINT } from './constants';
import { setupNodeWrapper } from './utils';
import { startProxy, stopProxy } from './proxy';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LS_STARTUP_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Crash Monitoring Constants
// ---------------------------------------------------------------------------

const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS = 3;
const RESTART_COOLDOWN_MS = 2000;
const MAX_STDERR_BUFFER = 100000;
const CRASH_TRIGGER_PHRASES = [
  'panic:',
  'fatal error:',
  'unexpected fault address',
  'runtime:',
  'running GoogleExitFunction',
  'panic serving',
];

const isWindows = process.platform === 'win32';
const binName = isWindows ? 'language_server.exe' : 'language_server';
export const LS_BINARY = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', binName)
  : process.env.CODEIUM_LANGUAGE_SERVER_BIN || path.join(__dirname, '..', 'bin', binName);

export interface LanguageServerHandle {
  port: number;
  process: ChildProcess;
  exitPromise: Promise<ExitInfo>;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  crashStackTrace: string | undefined;
}

export interface StartMonitorOptions {
  headless?: boolean;
  onPortChanged?: (newPort: number) => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _lsProcess: ChildProcess | null = null;
let _lsPort = 0;
let _intentionalTermination = false;
let _restartCount = 0;
let _lastRestartTime = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gets the build CL of the language server by running it with --stamp.
 */
export function getLsCL(): Promise<string> {
  return new Promise((resolve) => {
    execFile(LS_BINARY, ['--stamp'], (error, stdout, _stderr) => {
      if (error) {
        console.error('Failed to get LS stamp:', error);
        resolve('');
        return;
      }
      const match = /Built at CL: (\d+)/.exec(stdout);
      if (match) {
        resolve(match[1]);
      } else {
        resolve('');
      }
    });
  });
}

// Pattern: "listening on <proto> port at <N> for HTTP or HTTPS"
const PORT_PATTERN = /listening on \w+ port at (\d+) for HTTP(S)?\b/i;
// Pattern: OAuth authorization URL
const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/;

/** Returns the active language server process, or null if not running. */
export function getLsProcess(): ChildProcess | null {
  return _lsProcess;
}

/** Returns the active language server port, or 0 if not running. */
export function getLsPort(): number {
  return _lsPort;
}

/** Clears the language server process reference (call after killing it). */
export function clearLsProcess(): void {
  _lsProcess = null;
}

// ---------------------------------------------------------------------------
// Crash log extraction
// ---------------------------------------------------------------------------

/**
 * Extract lines after a crash trigger phrase from a list of stderr lines.
 * Returns all lines from the first trigger phrase onwards.
 */
function getLinesAfterCrash(lines: string[]): string[] {
  const crashLines: string[] = [];
  let foundTrigger = false;
  for (const line of lines) {
    if (CRASH_TRIGGER_PHRASES.some((phrase) => line.includes(phrase))) {
      foundTrigger = true;
    }
    if (foundTrigger) {
      crashLines.push(line);
    }
  }
  return crashLines;
}

/**
 * Best-effort extraction of the crash stack trace from buffered stderr.
 * Returns the stack trace string, or undefined if no trigger phrase was found.
 */
export function extractCrashStackTrace(stderr: string): string | undefined {
  const lines = stderr.split('\n');
  const crashLines = getLinesAfterCrash(lines);
  return crashLines.length > 0 ? crashLines.join('\n') : undefined;
}

interface NodeModuleConfig {
  name: string;
  envVar: string;
  relativePath: string[];
}

/**
 * Sets environment variables for bundled node modules so the language
 * server can find them.
 *
 * NOTE: If you add a new module that needs to be executed this way:
 * 1. Add it to `asarUnpack` in `package.json` so it is available on the filesystem.
 * 2. Add it to `modules` in the callsite of setupNodeModules.
 */
function setupNodeModules(env: Record<string, string | undefined>, modules: NodeModuleConfig[]): void {
  for (const mod of modules) {
    let entryPoint = '';
    if (!app.isPackaged) {
      entryPoint = path.join(__dirname, '..', 'node_modules', mod.name, ...mod.relativePath);
    } else {
      entryPoint = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', mod.name, ...mod.relativePath);
    }
    env[mod.envVar] = entryPoint;
  }
}

/**
 * Spawn the language server and resolve with a LanguageServerHandle once
 * the LS reports its HTTP port. Rejects on timeout or unexpected exit
 * during startup.
 *
 * After resolving, callers should monitor `handle.exitPromise` to detect
 * crashes that occur after startup.
 */
export function startLanguageServer(port: number, csrf: string, headless?: boolean): Promise<LanguageServerHandle> {
  return new Promise(async (resolve, reject) => {
    const logStream = fs.createWriteStream(getLsLogPath(), { flags: 'w' });

    let proxyPort: number | undefined;
    try {
      proxyPort = await startProxy();
    } catch (err) {
      console.error('[LanguageServer] Failed to start local proxy:', err);
    }

    const apiServerUrl = proxyPort ? `http://localhost:${proxyPort}` : 'https://generativelanguage.googleapis.com';

    // We need to pass the override flags because the LS is running in standalone mode
    const args: string[] = [
      '--standalone',
      '--override_ide_name',
      'antigravity',
      '--subclient_type',
      'hub',
      '--override_ide_version',
      app.getVersion(),
      '--override_user_agent_name',
      'antigravity',
      '--https_server_port',
      String(port),
      '--csrf_token',
      csrf,
      '--app_data_dir',
      getAppDataDirName(),
      '--api_server_url',
      apiServerUrl,
      '--cloud_code_endpoint',
      apiServerUrl,
      '--enable_sidecars',
    ];
    if (headless) {
      args.push('--headless');
    }
    // P0-3: Mask CSRF token in terminal output
    const safeArgs = args.map((a) => (a === csrf ? '***' : a));
    console.log(`\nSpawning: ${LS_BINARY} ${safeArgs.join(' ')}\n`);
    // Electron apps don't inherit shell environment variables when they are not launched through the terminal.
    // We need to load the shell env explicitly so the language server can discover tools in the user's environment.
    const env: Record<string, string | undefined> = { ...process.env, ...shellEnvSync() };
    // We don't read the file to avoid adding start up latency.
    // LS will read when browser recording encoder is invoked.
    env['AGY_BROWSER_ACTIVE_PORT_FILE'] = getActivePortFilePath();
    setupNodeWrapper(env);
    setupNodeModules(env, [
      {
        name: 'chrome-devtools-mcp',
        envVar: 'CHROME_DEVTOOLS_MCP_JS',
        relativePath: ['build', 'src', 'bin', 'chrome-devtools-mcp.js'],
      },
    ]);
    _lsProcess = spawn(LS_BINARY, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as Record<string, string>,
    });
    if (!headless) {
      // Close stdin immediately — the LS may block waiting for metadata on stdin.
      _lsProcess.stdin?.end();
    }
    const combined = new PassThrough();
    _lsProcess.stdout?.pipe(combined, { end: false });
    _lsProcess.stderr?.pipe(combined, { end: false });
    // Buffer stderr for crash log extraction (ring buffer)
    const stderrChunks: string[] = [];
    let stderrLength = 0;
    _lsProcess.stderr?.on('data', (data) => {
      const str = data.toString();
      stderrChunks.push(str);
      stderrLength += str.length;
      while (stderrChunks.length > 0 && stderrLength > MAX_STDERR_BUFFER) {
        stderrLength -= stderrChunks.shift()!.length;
      }
    });
    let resolved = false;
    let logStreamEnded = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Timeout: language server did not report its port within ${LS_STARTUP_TIMEOUT_MS / 1000}s`));
      }
    }, LS_STARTUP_TIMEOUT_MS);
    const rl = readline.createInterface({ input: combined, crlfDelay: Infinity });
    rl.on('close', () => {
      if (!logStreamEnded) {
        logStreamEnded = true;
        logStream.end();
      }
    });
    rl.on('line', (line) => {
      if (!logStreamEnded) {
        logStream.write(line + '\n');
      }
      if (!resolved) {
        const m = PORT_PATTERN.exec(line);
        if (m) {
          resolved = true;
          clearTimeout(timer);
          const actualPort = parseInt(m[1], 10);
          _lsPort = actualPort;
          resolve({
            port: actualPort,
            process: _lsProcess!,
            exitPromise,
          });
        }
      }
      const authMatch = AUTH_URL_PATTERN.exec(line);
      if (authMatch) {
        console.log('\n' + '='.repeat(60));
        console.log('  Please visit the following URL to authorize.');
        console.log('  After authorizing, paste the authorization code below.');
        console.log(`  ${authMatch[0]}`);
        console.log('='.repeat(60) + '\n');
      }
    });
    // Exit promise — resolves whenever the process exits (whether during
    // startup or after). Includes crash stack trace extraction.
    const exitPromise = new Promise<ExitInfo>((exitResolve) => {
      _lsProcess!.on('exit', (code, signal) => {
        if (!logStreamEnded) {
          logStreamEnded = true;
          logStream.end();
        }
        const fullStderr = stderrChunks.join('');
        const crashStackTrace = extractCrashStackTrace(fullStderr);
        // If we haven't resolved the startup promise yet, reject it.
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`Language server exited unexpectedly (code=${code}, signal=${signal})`));
        }
        exitResolve({ code, signal, crashStackTrace });
      });
    });
  });
}

/** Sets whether the termination was intentional (suppresses crash reports). */
export function setIntentionalTermination(value: boolean): void {
  _intentionalTermination = value;
}

/**
 * Start the language server AND set up the restart monitoring loop.
 * Resolves with the handle on first successful startup.
 */
export async function startAndMonitorLanguageServer(
  port: number,
  csrf: string,
  options: StartMonitorOptions = {},
): Promise<LanguageServerHandle> {
  setIntentionalTermination(false); // Reset
  const handle = await startLanguageServer(port, csrf, options.headless);
  _lsPort = handle.port;
  if (options.onPortChanged) {
    options.onPortChanged(_lsPort);
  }
  monitorLsCrashInternal(handle, port, csrf, options);
  return handle;
}

function monitorLsCrashInternal(
  handle: LanguageServerHandle,
  port: number,
  csrf: string,
  options: StartMonitorOptions,
): void {
  void handle.exitPromise.then(async (exitInfo) => {
    clearLsProcess();
    if (_intentionalTermination) {
      return;
    }
    const { code, signal, crashStackTrace } = exitInfo;
    const summary = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
    console.error(`\nLanguage server crashed: ${summary}`);
    if (crashStackTrace) {
      console.error('--- Crash Stack Trace ---');
      console.error(crashStackTrace);
      console.error('--- End Crash Stack trace ---');
    }
    const now = Date.now();
    if (now - _lastRestartTime > RESTART_WINDOW_MS) {
      _restartCount = 0;
    }
    _lastRestartTime = now;
    if (_restartCount >= MAX_RESTARTS) {
      const msg = `Language server crashed ${MAX_RESTARTS} times in a row. Giving up.`;
      console.error(msg);
      return;
    }
    _restartCount++;
    console.log(`Attempting restart ${_restartCount}/${MAX_RESTARTS} in ${RESTART_COOLDOWN_MS / 1000}s...`);
    await sleep(RESTART_COOLDOWN_MS);
    if (_intentionalTermination) {
      return;
    }
    try {
      const newHandle = await startLanguageServer(port, csrf);
      _lsPort = newHandle.port;
      if (options.onPortChanged) {
        options.onPortChanged(_lsPort);
      }
      // Recurse
      monitorLsCrashInternal(newHandle, port, csrf, options);
    } catch (err) {
      console.error(`Failed to restart language server: ${(err as Error).message}`);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killLanguageServer(): Promise<void> {
  setIntentionalTermination(true);
  await stopProxy();
  const proc = getLsProcess();
  if (proc) {
    const pid = proc.pid;
    console.log('Shutting down language server…');
    const exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', () => {
        resolve();
      });
    });
    proc.kill('SIGTERM');
    const result = await Promise.race([
      exitPromise.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    if (result === 'timeout' && pid !== undefined) {
      console.warn(`Language server (PID ${pid}) did not exit gracefully within 5s. Sending SIGKILL.`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already dead or exited
      }
    }
    clearLsProcess();
  }
}

/**
 * Sets up certificate verification in Electron to trust the local self-signed cert
 * used by the language server. It verifies that the certificate fingerprint matches
 * the hardcoded `LS_CERT_FINGERPRINT`.
 *
 * TODO: Generate the cert.pem file dynamically
 */
export function setupLocalCertTrust(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (
      (request.hostname === '127.0.0.1' || request.hostname === 'localhost') &&
      request.certificate.fingerprint === LS_CERT_FINGERPRINT
    ) {
      callback(0); // Accept
    } else {
      callback(-3); // Default validation
    }
  });
}
