import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

function validPort(port: unknown): port is number {
  return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;
}

function loopbackOrigins(port: number, protocols: string[]): string[] {
  return protocols.flatMap((protocol) => [`${protocol}//127.0.0.1:${port}`, `${protocol}//localhost:${port}`]);
}

/** Native language-server callers omit Origin; browser callers must use an owned origin. */
export function guardLoopbackRequest(req: IncomingMessage, res: ServerResponse, languageServerPort?: number): boolean {
  const port = req.socket.localPort;
  const duplicate = ['host', 'origin'].some(
    (name) =>
      req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1,
  );
  const allowedOrigins = validPort(port) ? loopbackOrigins(port, ['http:']) : [];
  if (validPort(languageServerPort)) allowedOrigins.push(...loopbackOrigins(languageServerPort, ['http:', 'https:']));
  if (
    duplicate ||
    !validPort(port) ||
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || '') ||
    (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin))
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Service is available only at its loopback origin' }));
    return false;
  }
  return true;
}

/** The desktop supplies its current LS port, never a port learned from an HTTP caller. */
export function languageServerModelsUrl(value: string, port?: number): URL | undefined {
  if (!validPort(port)) return undefined;
  try {
    const url = new URL(value);
    if (
      value !== url.href ||
      !loopbackOrigins(port, ['http:', 'https:']).includes(url.origin) ||
      ![
        '/LanguageServerService/GetAvailableModels',
        '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
      ].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Incoming Google credentials may only accompany HTTPS downloads from Google API hosts. */
export function authenticatedGoogleFileUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'googleapis.com' && !url.hostname.endsWith('.googleapis.com')) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Converting a file URL must never turn an attachment into a remote SMB read. */
export function localFilePath(url: URL): string {
  const remoteFileError = 'Only local file URLs are supported; network shares are not allowed.';
  if (
    url.protocol !== 'file:' ||
    (url.hostname && url.hostname.toLowerCase() !== 'localhost') ||
    /^[\\/]{2}/.test(url.pathname)
  ) {
    throw new Error(remoteFileError);
  }
  let localPath: string;
  try {
    localPath = fileURLToPath(url);
  } catch {
    throw new Error('Invalid local attachment file URL.');
  }
  if (/^[\\/]{2}/.test(localPath)) throw new Error(remoteFileError);
  return localPath;
}
