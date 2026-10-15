import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { attemptGooglePoolFailover } from '../proxy/googlePoolFailover';
import { resetGoogleAccountState, getGooglePoolStatus } from '../googleAccounts';

describe('googlePoolFailover', () => {
  beforeEach(() => {
    resetGoogleAccountState();
  });

  function mockReq(url = '/v1internal:streamGenerateContent?alt=sse', headers: Record<string, string> = {}) {
    const req = new EventEmitter() as any;
    req.url = url;
    req.method = 'POST';
    req.headers = {
      authorization: 'Bearer token-failing',
      'content-type': 'application/json',
      ...headers,
    };
    return req;
  }

  function mockRes() {
    const res = new EventEmitter() as any;
    res.destroyed = false;
    res.writableEnded = false;
    res.headersSent = false;
    res.writeHead = vi.fn((statusCode: number, headers?: any) => {
      res.statusCode = statusCode;
      res.headersSent = true;
      return res;
    });
    res.write = vi.fn();
    res.end = vi.fn();
    return res;
  }

  function mockErrorRes(statusCode = 429, retryAfter?: string) {
    const errorRes = new EventEmitter() as any;
    errorRes.statusCode = statusCode;
    errorRes.headers = retryAfter ? { 'retry-after': retryAfter } : {};
    return errorRes;
  }

  it('returns false when error is not rate limited (e.g. 200 or 500)', async () => {
    const req = mockReq();
    const res = mockRes();
    const errorRes = mockErrorRes(500);
    const handled = await attemptGooglePoolFailover(
      req,
      res,
      Buffer.from('{}'),
      errorRes,
      'Internal Server Error',
      {
        loadCustomModels: () => [],
        forwardingHeaders: (h) => ({ ...h }),
      },
    );
    expect(handled).toBe(false);
  });

  it('returns false when no Google Cloud Code accounts exist in custom models', async () => {
    const req = mockReq();
    const res = mockRes();
    const errorRes = mockErrorRes(429);
    const handled = await attemptGooglePoolFailover(
      req,
      res,
      Buffer.from('{"model":"gemini-3.8-pro"}'),
      errorRes,
      JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } }),
      {
        loadCustomModels: () => [{ name: 'models/openai', provider: 'openai', apiKey: 'sk-test' }],
        forwardingHeaders: (h) => ({ ...h }),
      },
    );
    expect(handled).toBe(false);
  });

  it('fails over to standby Google account on 429 and streams 200 response to client', async () => {
    const failingAccount = {
      id: 'acc-1',
      label: 'Failing Account',
      accessToken: 'token-failing',
      refreshToken: 'rf-1',
      project: 'aicode-consumers',
      authMode: 'antigravity' as const,
      enabled: true,
    };
    const standbyAccount = {
      id: 'acc-2',
      label: 'Standby Account',
      accessToken: 'token-standby',
      refreshToken: 'rf-2',
      project: 'aicode-consumers',
      authMode: 'antigravity' as const,
      enabled: true,
    };
    const poolModel = {
      name: 'models/pool',
      provider: 'google-cloudcode',
      googlePool: { strategy: 'least-loaded', cooldownMs: 60000 },
      googleAccounts: [failingAccount, standbyAccount],
    };

    const req = mockReq('/v1internal:streamGenerateContent?alt=sse', {
      authorization: 'Bearer token-failing',
    });
    const res = mockRes();
    const errorRes = mockErrorRes(429);

    let interceptedAuth: string | undefined;
    const requestFn = ((target: any, options: any, cb: any) => {
      interceptedAuth = options.headers?.authorization;
      const clientReq = new EventEmitter() as any;
      clientReq.end = vi.fn(() => {
        const upstreamRes = new EventEmitter() as any;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = { 'content-type': 'text/event-stream' };
        upstreamRes.pipe = (dest: any) => {
          dest.write('data: {"candidates":[]}\n\n');
        };
        cb(upstreamRes);
        upstreamRes.emit('data', Buffer.from('data: {"candidates":[]}\n\n'));
        upstreamRes.emit('end');
      });
      return clientReq;
    }) as any;

    const handled = await attemptGooglePoolFailover(
      req,
      res,
      Buffer.from(JSON.stringify({ model: 'gemini-3.8-pro', project: 'aicode-consumers' })),
      errorRes,
      JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }),
      {
        loadCustomModels: () => [poolModel],
        forwardingHeaders: (h) => ({ ...h }),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        requestFn,
      },
    );

    expect(handled).toBe(true);
    expect(interceptedAuth).toBe('Bearer token-standby');
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

    // Failing account should be in cooldown in pool status
    const status = getGooglePoolStatus();
    const failingStatus = status.find((s) => s.id === 'acc-1');
    expect(failingStatus?.status).toBe('cooldown');
  });

  it('tries next standby account if first standby account also returns 429', async () => {
    const acc1 = {
      id: 'acc-1',
      label: 'Acc 1',
      accessToken: 'token-1',
      project: 'aicode-consumers',
      enabled: true,
    };
    const acc2 = {
      id: 'acc-2',
      label: 'Acc 2',
      accessToken: 'token-2',
      project: 'aicode-consumers',
      enabled: true,
    };
    const acc3 = {
      id: 'acc-3',
      label: 'Acc 3',
      accessToken: 'token-3',
      project: 'aicode-consumers',
      enabled: true,
    };

    const poolModel = {
      name: 'models/pool',
      provider: 'google-cloudcode',
      googlePool: { strategy: 'round-robin', cooldownMs: 60000 },
      googleAccounts: [acc1, acc2, acc3],
    };

    const req = mockReq('/v1internal:generateContent', {
      authorization: 'Bearer token-1',
    });
    const res = mockRes();
    const errorRes = mockErrorRes(429);

    const attemptedTokens: string[] = [];
    const requestFn = ((target: any, options: any, cb: any) => {
      const auth = String(options.headers?.authorization || '');
      attemptedTokens.push(auth);
      const clientReq = new EventEmitter() as any;
      clientReq.end = vi.fn(() => {
        const upstreamRes = new EventEmitter() as any;
        if (auth.includes('token-2')) {
          upstreamRes.statusCode = 429;
          upstreamRes.headers = {};
          cb(upstreamRes);
          upstreamRes.emit('data', Buffer.from(JSON.stringify({ error: { code: 429 } })));
          upstreamRes.emit('end');
        } else if (auth.includes('token-3')) {
          upstreamRes.statusCode = 200;
          upstreamRes.headers = { 'content-type': 'application/json' };
          upstreamRes.pipe = (dest: any) => dest.write('{"response":"ok"}');
          cb(upstreamRes);
          upstreamRes.emit('data', Buffer.from('{"response":"ok"}'));
          upstreamRes.emit('end');
        }
      });
      return clientReq;
    }) as any;

    const handled = await attemptGooglePoolFailover(
      req,
      res,
      Buffer.from(JSON.stringify({ model: 'gemini-3.8-pro' })),
      errorRes,
      JSON.stringify({ error: { code: 429, message: 'Rate limited' } }),
      {
        loadCustomModels: () => [poolModel],
        forwardingHeaders: (h) => ({ ...h }),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        requestFn,
      },
    );

    expect(handled).toBe(true);
    expect(attemptedTokens).toContain('Bearer token-2');
    expect(attemptedTokens).toContain('Bearer token-3');
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});
