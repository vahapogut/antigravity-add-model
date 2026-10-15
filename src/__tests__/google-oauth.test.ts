import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { loginGoogleAccount, GOOGLE_AUTHORIZATION_URL, GOOGLE_TOKEN_URL, parseGoogleIdToken } from '../googleOAuth';
import { GOOGLE_NATIVE_SCOPES } from '../googleNativeClient';

const clientId = 'unit-test-client.apps.googleusercontent.com';
const tokenResponse = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 120 };
vi.mock('node:https', () => ({ request: vi.fn() }));
const tokenServers: http.Server[] = [];
afterEach(async () => {
  vi.mocked(https.request).mockReset();
  for (const server of tokenServers) server.closeAllConnections();
  await Promise.all(
    tokenServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function request(url: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('Test callback timeout')));
    req.end();
  });
}
function makeAttempt(
  options: Parameters<typeof loginGoogleAccount>[0] = { clientId },
  exchange = vi.fn(async () => tokenResponse),
  resolveNativeClient?: Parameters<typeof loginGoogleAccount>[2]['resolveNativeClient'],
) {
  let opened!: (value: URL) => void;
  const authorization = new Promise<URL>((done) => (opened = done));
  const openExternal = vi.fn(async (url: string) => {
    opened(new URL(url));
  });
  const result = loginGoogleAccount(options, openExternal, {
    exchangeToken: exchange,
    now: () => 1000000,
    resolveNativeClient,
  });
  // Failure cases must have a rejection handler before triggering abort/denial.
  void result.catch(() => {});
  return { authorization, result, exchange, openExternal };
}
function callback(authorization: URL, params: Record<string, string> = {}): string {
  const url = new URL(authorization.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({
    code: 'test-code',
    state: authorization.searchParams.get('state')!,
    ...params,
  }).toString();
  return url.toString();
}

describe('explicit Google desktop OAuth', () => {
  const nativeClient = {
    clientId: 'fixture-native.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-fixture-native',
    scopes: [...GOOGLE_NATIVE_SCOPES],
  };

  it('uses the recognized native personal profile, vendor callback, account choice, state and PKCE', async () => {
    const resolveNativeClient = vi.fn(() => nativeClient);
    const attempt = makeAttempt(
      { authMode: 'antigravity', clientId: 'ignored-invalid-custom-id', clientSecret: 'ignored-secret' },
      vi.fn(async () => tokenResponse),
      resolveNativeClient,
    );
    const auth = await attempt.authorization;
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    expect(resolveNativeClient).toHaveBeenCalledOnce();
    expect(auth.searchParams.get('client_id')).toBe(nativeClient.clientId);
    expect(auth.searchParams.get('scope')).toBe(nativeClient.scopes.join(' '));
    expect(auth.searchParams.get('prompt')).toBe('select_account consent');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.has('client_secret')).toBe(false);
    expect(redirect.hostname).toBe('localhost');
    expect(redirect.pathname).toBe('/oauth-callback');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect((await request(callback(auth, { state: 'invalid' }))).status).toBe(400);
    const wrongPath = new URL(callback(auth));
    wrongPath.pathname = '/oauth2callback';
    expect((await request(wrongPath.toString())).status).toBe(404);
    expect(attempt.exchange).not.toHaveBeenCalled();
    const response = await request(callback(auth));
    expect(response.status).toBe(200);
    expect(response.body).not.toMatch(/test-access|test-refresh|GOCSPX/);
    const parameters = attempt.exchange.mock.calls[0][0] as URLSearchParams;
    expect(parameters.get('client_id')).toBe(nativeClient.clientId);
    expect(parameters.get('client_secret')).toBe(nativeClient.clientSecret);
    expect(parameters.get('redirect_uri')).toBe(redirect.toString());
    expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
    expect(await attempt.result).toMatchObject({
      authMode: 'antigravity',
      clientId: nativeClient.clientId,
      clientSecret: nativeClient.clientSecret,
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
    });
  });

  it('never opens a browser or silently falls back when the native profile is unavailable', async () => {
    const open = vi.fn();
    const exchange = vi.fn();
    await expect(
      loginGoogleAccount({ authMode: 'antigravity', clientId }, open, {
        exchangeToken: exchange,
        resolveNativeClient: () => {
          throw new Error('Supported native installation is unavailable');
        },
      }),
    ).rejects.toThrow('native installation is unavailable');
    expect(open).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('cancels native login and rejects unsupported auth modes before resolving a profile', async () => {
    const resolver = vi.fn(() => nativeClient);
    const controller = new AbortController();
    const attempt = makeAttempt(
      { authMode: 'antigravity', signal: controller.signal },
      vi.fn(async () => tokenResponse),
      resolver,
    );
    const auth = await attempt.authorization;
    controller.abort();
    await expect(attempt.result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(request(callback(auth))).rejects.toThrow();
    const open = vi.fn();
    await expect(
      loginGoogleAccount({ authMode: 'other' as 'custom' }, open, { resolveNativeClient: resolver }),
    ).rejects.toThrow('Choose Antigravity');
    expect(open).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it.each([
    [403, /OAuth client, consent\/test users/],
    [429, /rate or quota limit/],
    [503, /temporarily unavailable/],
  ] as const)(
    'explains HTTP %s from the real token-exchange path without echoing provider content',
    async (status, guidance) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(status);
        res.end('<html>test-client-secret test-code test-access test-refresh</html>');
      });
      tokenServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      vi.mocked(https.request).mockImplementation(((
        target: string,
        options: http.RequestOptions,
        receive: (response: http.IncomingMessage) => void,
      ) => {
        expect(target).toBe(GOOGLE_TOKEN_URL);
        return http.request(`http://127.0.0.1:${port}/token`, options, receive);
      }) as typeof https.request);
      let opened!: (url: URL) => void;
      const authorization = new Promise<URL>((resolve) => {
        opened = resolve;
      });
      const result = loginGoogleAccount({ clientId, clientSecret: 'test-client-secret' }, async (url) => {
        opened(new URL(url));
      }).catch((error: Error) => error);
      const response = await request(callback(await authorization));
      expect(response.status).toBe(502);
      const failure = await result;
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(guidance);
      expect(String(failure)).toContain(`HTTP ${status}`);
      expect(`${response.body} ${String(failure)}`).not.toMatch(
        /test-client-secret|test-code|test-access|test-refresh/,
      );
      expect(https.request).toHaveBeenCalledOnce();
    },
  );

  it('uses official endpoints, a random loopback port, state and PKCE without exposing tokens to the browser', async () => {
    const attempt = makeAttempt({ clientId, clientSecret: 'test-client-secret', label: 'Personal' });
    const auth = await attempt.authorization;
    expect(`${auth.origin}${auth.pathname}`).toBe(GOOGLE_AUTHORIZATION_URL);
    expect(GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(auth.searchParams.get('client_id')).toBe(clientId);
    expect(auth.searchParams.has('client_secret')).toBe(false);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(redirect.pathname).toBe('/oauth2callback');
    const response = await request(callback(auth));
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('test-access');
    expect(response.body).not.toContain('test-refresh');
    const parameters = attempt.exchange.mock.calls[0][0] as URLSearchParams;
    expect(parameters.get('client_secret')).toBe('test-client-secret');
    expect(parameters.get('code')).toBe('test-code');
    expect(parameters.get('redirect_uri')).toBe(redirect.toString());
    expect(parameters.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
    expect(await attempt.result).toMatchObject({
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: 1120000,
      clientId,
      clientSecret: 'test-client-secret',
      label: 'Personal',
    });
  });

  it('rejects wrong and malformed state without consuming the valid login attempt', async () => {
    const attempt = makeAttempt();
    const auth = await attempt.authorization;
    expect((await request(callback(auth, { state: 'wrong' }))).status).toBe(400);
    expect((await request(callback(auth, { state: 'é'.repeat(43) }))).status).toBe(400);
    const duplicate = callback(auth) + '&state=duplicate';
    expect((await request(duplicate)).status).toBe(400);
    expect(attempt.exchange).not.toHaveBeenCalled();
    expect((await request(callback(auth))).status).toBe(200);
    await attempt.result;
    expect(attempt.exchange).toHaveBeenCalledOnce();
  });

  it('handles consent denial without exchanging a token', async () => {
    const attempt = makeAttempt();
    const auth = await attempt.authorization;
    expect((await request(callback(auth, { error: 'access_denied' }))).status).toBe(400);
    await expect(attempt.result).rejects.toThrow('denied or cancelled');
    expect(attempt.exchange).not.toHaveBeenCalled();
    await expect(request(callback(auth))).rejects.toThrow();
  });

  it('closes the listener on timeout and on explicit cancellation', async () => {
    const timed = makeAttempt({ clientId, timeoutMs: 100 });
    const timedAuth = await timed.authorization;
    await expect(timed.result).rejects.toThrow('timed out');
    await expect(request(callback(timedAuth))).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = makeAttempt({ clientId, signal: controller.signal });
    const cancelAuth = await cancelled.authorization;
    controller.abort();
    await expect(cancelled.result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(request(callback(cancelAuth))).rejects.toThrow();
  });

  it('does not open a browser for invalid or already-cancelled inputs', async () => {
    const openExternal = vi.fn();
    await expect(loginGoogleAccount({ clientId: '' }, openExternal)).rejects.toThrow('client ID');
    await expect(loginGoogleAccount({ clientId: 'https://other.example' }, openExternal)).rejects.toThrow('client ID');
    const controller = new AbortController();
    controller.abort();
    await expect(loginGoogleAccount({ clientId, signal: controller.signal }, openExternal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cleans up when the browser cannot be opened', async () => {
    let auth: URL | undefined;
    await expect(
      loginGoogleAccount({ clientId }, async (url) => {
        auth = new URL(url);
        throw new Error('Cannot launch');
      }),
    ).rejects.toThrow('Could not open the browser');
    await expect(request(callback(auth!))).rejects.toThrow();
  });

  it('cancels an in-flight exchange and rejects duplicate callbacks', async () => {
    const controller = new AbortController();
    let exchangeSignal: AbortSignal | undefined;
    const exchange = vi.fn(
      (_parameters: URLSearchParams, signal: AbortSignal) =>
        new Promise<typeof tokenResponse>((_resolve, reject) => {
          exchangeSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const attempt = makeAttempt({ clientId, signal: controller.signal }, exchange);
    const auth = await attempt.authorization;
    const first = request(callback(auth));
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    expect((await request(callback(auth))).status).toBe(409);
    controller.abort();
    await expect(attempt.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(exchangeSignal?.aborted).toBe(true);
    expect((await first).status).toBe(502);
  });

  it('parses email and name from id_token and sets them on the account', async () => {
    const payload = Buffer.from(JSON.stringify({ email: 'user@gmail.com', name: 'User Name' })).toString('base64url');
    const fakeIdToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
    const attempt = makeAttempt(
      { clientId },
      vi.fn(async () => ({ ...tokenResponse, id_token: fakeIdToken })),
    );
    const auth = await attempt.authorization;
    await request(callback(auth));
    const account = await attempt.result;
    expect(account.email).toBe('user@gmail.com');
    expect(account.label).toBe('user@gmail.com');
  });

  it('preserves an explicit user label even when email is present in id_token', async () => {
    const payload = Buffer.from(JSON.stringify({ email: 'user@gmail.com', name: 'User Name' })).toString('base64url');
    const fakeIdToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
    const attempt = makeAttempt(
      { clientId, label: 'Custom Work Account' },
      vi.fn(async () => ({ ...tokenResponse, id_token: fakeIdToken })),
    );
    const auth = await attempt.authorization;
    await request(callback(auth));
    const account = await attempt.result;
    expect(account.email).toBe('user@gmail.com');
    expect(account.label).toBe('Custom Work Account');
  });

  it('correctly parses valid and invalid id_tokens in parseGoogleIdToken helper', () => {
    expect(parseGoogleIdToken(undefined)).toBeUndefined();
    expect(parseGoogleIdToken('invalid')).toBeUndefined();
    const payload = Buffer.from(JSON.stringify({ email: 'hello@world.com', name: 'Hello World' })).toString('base64url');
    expect(parseGoogleIdToken(`header.${payload}.sig`)).toEqual({
      email: 'hello@world.com',
      name: 'Hello World',
    });
  });
});
