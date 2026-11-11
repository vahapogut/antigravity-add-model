#!/usr/bin/env node
// Start/stop only our authenticated loopback service. Never kill a process by port or stale PID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseServiceOptions(args) {
  const options = {
    command: args[0] || 'status',
    port: 50999,
    dataDirectory: path.join(os.homedir(), '.gemini', 'antigravity'),
    open: false,
  };
  if (!['start', 'stop', 'status', 'run'].includes(options.command)) throw new Error('Use start, stop, status or run');
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--open') options.open = true;
    else if (['--port', '--data-dir'].includes(args[i]) && args[i + 1]) {
      const flag = args[i++];
      if (flag === '--port') options.port = Number(args[i]);
      else options.dataDirectory = path.resolve(args[i]);
    } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('Port must be 1–65535');
  return options;
}

function files(options) {
  const directory = path.join(options.dataDirectory, '.ide-proxy');
  for (const target of [options.dataDirectory, directory]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error(`Refusing linked service directory: ${target}`);
  }
  return {
    directory,
    state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'start.lock'),
    log: path.join(directory, 'service.log'),
  };
}
function readState(options) {
  const { state } = files(options);
  try {
    if (fs.lstatSync(state).isSymbolicLink()) throw new Error('Refusing linked service state');
    if (fs.statSync(state).size > 8192) throw new Error('Oversized service state');
    const value = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (
      value?.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      !/^[a-f0-9-]{36}$/.test(value.instance) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      !Number.isInteger(value.pid) ||
      value.pid < 1
    )
      throw new Error('Invalid service state');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function request(state, route, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: state.port,
        path: `/_addon/${route}`,
        method,
        headers: { Authorization: `Bearer ${state.token}` },
        timeout: 1000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 8192) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(data) : null);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
async function health(state) {
  if (!state) return false;
  const value = await request(state, 'health');
  return (
    value?.service === 'antigravity-model-proxy' &&
    value.instance === state.instance &&
    value.pid === state.pid &&
    value.port === state.port
  );
}
function processMayBeAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access-denied and other inconclusive probes must not be mistaken for an exited process.
    return error.code !== 'ESRCH';
  }
}
function readRunLock(options) {
  const lock = path.join(files(options).directory, 'run.lock');
  try {
    const stat = fs.lstatSync(lock);
    if (stat.isSymbolicLink()) throw new Error('Refusing linked service lock');
    if (!stat.isFile() || stat.size > 32) throw new Error('Invalid service lock; inspect it before removal');
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid service lock; inspect it before removal');
    return pid;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function description(state, includeManagement = false) {
  const endpoint = `http://127.0.0.1:${state.port}`;
  return {
    status: 'running',
    endpoint,
    port: state.port,
    pid: state.pid,
    ...(includeManagement ? { managementUrl: `${endpoint}/_addon/#token=${state.token}` } : {}),
  };
}
function acquireLock(options, name = 'start.lock') {
  const p = files(options);
  p.lock = path.join(p.directory, name);
  fs.mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.lstatSync(p.lock).isSymbolicLink()) throw new Error('Refusing linked service lock');
    const pid = Number(fs.readFileSync(p.lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid service lock; inspect it before removal');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('Another service start is in progress');
    fs.unlinkSync(p.lock);
    fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => {
    if (fs.readFileSync(p.lock, 'utf8') === String(process.pid)) fs.unlinkSync(p.lock);
  };
}

export async function serviceCommand(options, hooks = {}) {
  const initial = readState(options);
  if (options.command === 'status') return (await health(initial)) ? description(initial) : { status: 'stopped' };
  if (options.command === 'stop') {
    // Do not send a stale management credential to a port after its recorded owner exited.
    if (!initial || !processMayBeAlive(initial.pid) || !(await health(initial))) {
      const lockPid = readRunLock(options);
      // Missing health can mean shutdown is hung, or that a stale PID was reused. It does not
      // authorize terminating that PID, nor prove that an installer can replace its files.
      if ([initial?.pid, lockPid].some((pid) => pid !== undefined && processMayBeAlive(pid)))
        throw new Error('Service shutdown could not be verified: a recorded process is still alive or inaccessible; no process was forcibly terminated');
      return { status: 'stopped', message: 'No owned service is responding and no recorded process remains alive' };
    }
    const stopped = await request(initial, 'stop', 'POST');
    if (!stopped?.success) throw new Error('The owned service did not accept shutdown');
    for (let i = 0; i < 100; i++) {
      const current = readState(options);
      if (current?.instance !== initial.instance && !fs.existsSync(path.join(files(options).directory, 'run.lock')) &&
          !processMayBeAlive(initial.pid))
        return { status: 'stopped' };
      await sleep(100);
    }
    throw new Error('Shutdown is still pending; no process was forcibly terminated');
  }
  if (options.command === 'run') {
    const releaseRun = acquireLock(options, 'run.lock');
    try {
      if (await health(readState(options))) throw new Error('An owned service already runs for this data directory');
      const { startStandaloneService } = require(path.join(ROOT, 'dist', 'standaloneService.js'));
      const p = files(options);
      fs.mkdirSync(p.directory, { recursive: true, mode: 0o700 });
      const state = {
        version: 1,
        pid: process.pid,
        port: options.port,
        token: randomBytes(32).toString('hex'),
        instance: randomUUID(),
      };
      const cleanup = () => {
        try {
          if (readState(options)?.instance === state.instance) fs.unlinkSync(p.state);
        } catch {
          /* Preserve unexpected state. */
        }
        releaseRun();
      };
      const running = await startStandaloneService({
        ...options,
        token: state.token,
        instance: state.instance,
        onStop: () => {
          cleanup();
          process.exit(0);
        },
      });
      try {
        // Atomic publication prevents status/start from reading a partial identity.
        const temporary = `${p.state}.${state.instance}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, p.state);
      } catch (error) {
        await running.stop();
        throw error;
      }
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          void running.stop().finally(() => {
            cleanup();
            process.exit(0);
          });
        });
      return description(state); // The listener keeps the process alive.
    } catch (error) {
      releaseRun();
      throw error;
    }
  }
  const release = acquireLock(options);
  try {
    const current = readState(options);
    let ready;
    if (await health(current)) {
      if (current.port !== options.port)
        throw new Error(`Owned service already uses port ${current.port}; stop it before changing ports`);
      ready = current;
    } else {
      const runtime = path.join(ROOT, 'dist', 'standaloneService.js');
      if (!fs.existsSync(runtime)) throw new Error('Build the project first: npm run build');
      const p = files(options);
      if (fs.existsSync(p.log) && fs.lstatSync(p.log).isSymbolicLink()) throw new Error('Refusing linked log file');
      const output = fs.openSync(p.log, 'a', 0o600);
      let child;
      try {
        child = spawn(
          process.execPath,
          [SELF, 'run', '--port', String(options.port), '--data-dir', options.dataDirectory],
          {
            detached: true,
            windowsHide: true,
            stdio: ['ignore', output, output],
            cwd: ROOT,
          },
        );
      } finally {
        fs.closeSync(output);
      }
      let failure;
      child.on('error', (error) => {
        failure = error;
      });
      child.on('exit', (code) => {
        failure = new Error(`Proxy exited (${code}); inspect ${p.log}`);
      });
      child.unref();
      for (let i = 0; i < 100; i++) {
        if (failure) throw failure;
        const candidate = readState(options);
        if (candidate?.pid === child.pid && candidate.port === options.port && (await health(candidate))) {
          ready = candidate;
          break;
        }
        await sleep(100);
      }
      if (!ready) throw new Error(`Proxy did not become ready; inspect ${p.log}`);
    }
    const result = description(ready, !options.open);
    if (options.open) {
      // Other local accounts can read a browser's command line, so it carries a single-use
      // sign-in code instead of the management token.
      const handoff = await request(ready, 'handoff', 'POST');
      if (!/^[a-f0-9]{64}$/.test(handoff?.code || ''))
        throw new Error(
          'The running service cannot issue a browser sign-in code. If it was started by an earlier version, stop it and start it again.',
        );
      const openBrowser = hooks.openBrowser || require(path.join(ROOT, 'dist', 'browserLauncher.js')).openBrowser;
      await openBrowser(`${result.endpoint}/_addon/#code=${handoff.code}`);
    }
    return result;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await serviceCommand(parseServiceOptions(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
