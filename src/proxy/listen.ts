import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import { createServer as createNetServer } from 'net';
import type { AddressInfo, Socket } from 'net';

/** The optional binary patch cannot follow the language server's dynamic port flag. */
export function getRequiredProxyPort(appPath: string): number | undefined {
  const marker = path.join(appPath, 'antigravity-proxy.json');
  if (!fs.existsSync(marker)) return undefined;
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (value?.requiredPort !== 50999) {
    throw new Error('Invalid antigravity-proxy.json: the binary patch requires port 50999');
  }
  return value.requiredPort;
}

const occupied = (port: number) =>
  `Port ${port} is occupied. The patched language server requires this exact port; close the other instance before starting Antigravity.`;

function listenIpv4(server: Server, preferredPort: number, allowFallback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    let triedFallback = false;
    const onListening = () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && allowFallback && !triedFallback) {
        triedFallback = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      if (error.code === 'EADDRINUSE' && !allowFallback) error.message = occupied(preferredPort);
      reject(error);
    };
    server.once('listening', onListening);
    server.on('error', onError);
    server.listen(preferredPort, '127.0.0.1');
  });
}

/**
 * Clients are given "localhost", which can resolve to ::1 before 127.0.0.1.
 * Holding the same port on both loopback addresses keeps one owner for it.
 * Rejects only when someone else already holds that port.
 */
function listenIpv6Loopback(server: Server, port: number, createCompanion: typeof createNetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const companion = createCompanion((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      server.emit('connection', socket);
    });
    companion.once('error', (error: NodeJS.ErrnoException) => {
      // A host without an IPv6 loopback has nothing to hold, so only a taken port is a conflict.
      if (error.code === 'EADDRINUSE') reject(error);
      else resolve();
    });
    companion.listen({ host: '::1', port, ipv6Only: true }, () => {
      companion.on('error', () => undefined);
      server.once('close', () => {
        companion.close();
        for (const socket of sockets) socket.destroy();
      });
      resolve();
    });
  });
}

export async function listenProxy(
  server: Server,
  preferredPort = 50999,
  allowFallback = true,
  createCompanion: typeof createNetServer = createNetServer,
): Promise<number> {
  let port = await listenIpv4(server, preferredPort, allowFallback);
  for (let attempt = 0; ; attempt++) {
    try {
      await listenIpv6Loopback(server, port, createCompanion);
      return port;
    } catch (error) {
      await new Promise<void>((done) => server.close(() => done()));
      if (!allowFallback) throw Object.assign(error as Error, { message: occupied(preferredPort) });
      // A random IPv4 port can still be held on the IPv6 loopback, so allow a few attempts.
      if (attempt >= 4) throw error;
      port = await listenIpv4(server, 0, false);
    }
  }
}
