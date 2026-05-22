import { protocol, net } from 'electron';

// A map of extension authority -> original URL (http://localhost:<port>)
// The authority is usually a hash of unique extension identifiers
// like extension ID + port + project ID. An extension running on localhost:<port>
// is then exposed on plugin://<authority>.
export const extensionAuthorities = new Map<string, string>();

export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: true,
        codeCache: true,
      },
    },
  ]);
}

export function registerCustomSchemeHandlers(): void {
  // Handle custom scheme for UI extensions
  protocol.handle('plugin', async (request) => {
    const url = new URL(request.url);
    const authority = url.hostname;
    const originalHost = extensionAuthorities.get(authority);
    if (!originalHost) {
      return new Response(null, { status: 404 });
    }
    const targetUrl = new URL(url.pathname + url.search, originalHost);
    try {
      const fetchOptions: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: request.headers,
        body: request.body,
      };
      if (request.body) {
        // Required by Electron's net.fetch when the body is a stream
        fetchOptions.duplex = 'half';
      }
      const response = await net.fetch(targetUrl.toString(), fetchOptions);
      return response;
    } catch (err) {
      console.error(`Failed to proxy request to ${targetUrl}:`, err);
      return new Response(null, { status: 500 });
    }
  });
}
