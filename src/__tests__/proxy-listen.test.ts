import { afterEach, describe, expect, it } from 'vitest';
import { createServer, get, type Server } from 'http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRequiredProxyPort, listenProxy } from '../proxy/listen';

const servers: (Server | NetServer)[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'antigravity-port-'));
  directories.push(directory);
  return directory;
}
function server() {
  const result = createServer((_req, res) => res.end('proxy fixture'));
  servers.push(result);
  return result;
}
/** Hold only the IPv6 loopback side of a port, as another local program could. */
function holdIpv6Loopback(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const holder = createNetServer();
    holder.once('error', () => resolve(undefined));
    holder.listen({ host: '::1', port: 0, ipv6Only: true }, () => {
      servers.push(holder);
      resolve((holder.address() as AddressInfo).port);
    });
  });
}
const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen({ host: '::1', port: 0, ipv6Only: true }, () => probe.close(() => resolve(true)));
});

describe('proxy listener used by the language server', () => {
  it('retains dynamic fallback when no fixed binary endpoint is required', async () => {
    const occupied = await listenProxy(server(), 0);
    const actual = await listenProxy(server(), occupied);
    expect(actual).not.toBe(occupied);
    expect(actual).toBeGreaterThan(0);
  });

  it('fails explicitly when the binary-required port is occupied', async () => {
    const occupied = await listenProxy(server(), 0);
    await expect(listenProxy(server(), occupied, false)).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringContaining('requires this exact port'),
    });
  });

  // Clients are given "localhost", which can resolve to ::1 before 127.0.0.1.
  it.skipIf(!hasIpv6Loopback)('answers on both loopback addresses of its port', async () => {
    const port = await listenProxy(server(), 0);
    const body = await new Promise<string>((resolve, reject) => {
      get({ host: '::1', port, path: '/', headers: { Host: `localhost:${port}` } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('proxy fixture');
  });

  it.skipIf(!hasIpv6Loopback)('moves to another port when the IPv6 loopback side is already held', async () => {
    const held = (await holdIpv6Loopback())!;
    const actual = await listenProxy(server(), held);
    expect(actual).not.toBe(held);
    expect(actual).toBeGreaterThan(0);
  });

  it.skipIf(!hasIpv6Loopback)('fails explicitly when the required port is held on the IPv6 loopback side', async () => {
    const held = (await holdIpv6Loopback())!;
    await expect(listenProxy(server(), held, false)).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringContaining('requires this exact port'),
    });
  });

  it('releases the port on both loopback addresses when the server closes', async () => {
    const first = server();
    const port = await listenProxy(first, 0);
    await new Promise<void>((resolve) => first.close(() => resolve()));
    expect(await listenProxy(server(), port, false)).toBe(port);
  });

  it('uses the installer marker to require the fixed port', () => {
    const directory = fixture();
    expect(getRequiredProxyPort(directory)).toBeUndefined();
    writeFileSync(join(directory, 'antigravity-proxy.json'), JSON.stringify({ requiredPort: 50999 }));
    expect(getRequiredProxyPort(directory)).toBe(50999);
  });

  it.each(['{', '{"requiredPort":80}', '{}'])('rejects invalid marker %s rather than choosing another port', (value) => {
    const directory = fixture();
    writeFileSync(join(directory, 'antigravity-proxy.json'), value);
    expect(() => getRequiredProxyPort(directory)).toThrow();
  });
});
