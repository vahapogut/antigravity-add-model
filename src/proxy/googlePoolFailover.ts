import type * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import {
  acquireGoogleAccount,
  googleAccountEndpoint,
  recordGoogleAccountFailure,
  type GoogleAccount,
  type GooglePoolOptions,
} from '../googleAccounts';
import { classifyGoogleRateLimit } from '../googlePoolPolicy';
import { forwardNativeGeneration, type NativeSubagentRouting } from './nativeSubagentResponse';

export interface PoolFailoverOptions {
  loadCustomModels: () => any[];
  forwardingHeaders: (source: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders;
  cloudCodeRouting?: { resolve: (headers: http.IncomingHttpHeaders) => string };
  log?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  requestFn?: typeof https.request;
}

/**
 * Intercepts Google Cloud Code 429 (Resource Exhausted / Rate Limit) errors during
 * generation requests and attempts transparent failover to standby accounts configured
 * in the user's Google Account Pool.
 *
 * Returns true if failover was handled (successfully streamed standby response or completed),
 * or false if failover could not be performed (no pool, not rate-limited, or all exhausted).
 */
export async function attemptGooglePoolFailover(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqBody: Buffer,
  errorRes: http.IncomingMessage,
  errorBody: string,
  options: PoolFailoverOptions,
  nativeSubagent?: NativeSubagentRouting,
  cloudCodeOrigin?: string,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return true;

  const status = errorRes.statusCode || 500;
  // Failover specifically on 429 Too Many Requests / Quota Exceeded, or 403 quota exhaustion
  const isRateLimit =
    status === 429 ||
    (status === 403 &&
      (errorBody.includes('RESOURCE_EXHAUSTED') ||
        errorBody.includes('quota') ||
        errorBody.includes('Rate limit exceeded')));

  if (!isRateLimit) return false;

  const models = options.loadCustomModels();
  const poolAccounts: GoogleAccount[] = [];
  let poolConfig: GooglePoolOptions | undefined;
  let poolModelName = 'models/google-pool';

  for (const m of models) {
    if (Array.isArray(m.googleAccounts) && m.googleAccounts.length > 0) {
      if (!poolConfig && m.googlePool) poolConfig = m.googlePool;
      poolModelName = m.name;
      for (const a of m.googleAccounts) {
        if (!poolAccounts.some((existing) => existing.id === a.id)) {
          poolAccounts.push(a);
        }
      }
    }
  }

  if (poolAccounts.length === 0) return false;

  const decision = classifyGoogleRateLimit(errorBody, errorRes.headers['retry-after']);

  // Extract the failing token from authorization header to identify the account
  const authHeader = String(req.headers['authorization'] || '');
  const currentToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const failingAccount = poolAccounts.find((a) => a.accessToken && a.accessToken === currentToken);

  let parsedBody: Record<string, unknown> | undefined;
  try {
    if (reqBody.length > 0) {
      parsedBody = JSON.parse(reqBody.toString('utf8'));
    }
  } catch {
    // Non-JSON or empty
  }

  const requestedModel =
    (typeof parsedBody?.model === 'string' ? parsedBody.model : undefined) ||
    poolModelName;
  const sessionId =
    (typeof parsedBody?.sessionId === 'string' ? parsedBody.sessionId : undefined) ||
    (typeof parsedBody?.conversationId === 'string' ? parsedBody.conversationId : undefined) ||
    (typeof (parsedBody?.request as any)?.sessionId === 'string'
      ? (parsedBody?.request as any).sessionId
      : undefined);

  if (failingAccount) {
    recordGoogleAccountFailure(
      failingAccount,
      status,
      decision.retryAfterMs,
      requestedModel,
      decision.reason,
    );
    options.log?.info?.(
      `[Proxy] Active Google account "${failingAccount.label || failingAccount.id}" rate-limited (${status}). Cooldown: ${decision.retryAfterMs ?? 60000}ms.`
    );
  }

  let candidates = poolAccounts.filter((a) => a.enabled !== false && a.id !== failingAccount?.id);
  if (candidates.length === 0) {
    options.log?.warn?.('[Proxy] No standby Google accounts available in pool for failover.');
    return false;
  }

  const maxAttempts = Math.min(3, candidates.length);
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    if (res.destroyed || res.writableEnded) return true;

    let lease;
    try {
      lease = await acquireGoogleAccount(
        requestedModel,
        candidates,
        poolConfig,
        sessionId,
        requestedModel,
      );
    } catch (err) {
      options.log?.warn?.('[Proxy] Could not acquire standby Google account lease:', err);
      break;
    }

    options.log?.info?.(
      `[Proxy] Failing over to standby Google account "${lease.account.label || lease.account.id}" (attempt ${attempt}/${maxAttempts})...`
    );

    const targetOrigin = googleAccountEndpoint(
      lease.account,
      options.cloudCodeRouting?.resolve(req.headers) || cloudCodeOrigin || 'https://daily-cloudcode-pa.googleapis.com',
    );
    const parsedUrl = new URL(req.url!, targetOrigin);

    const retryHeaders = options.forwardingHeaders(req.headers);
    retryHeaders['host'] = parsedUrl.host;
    retryHeaders['authorization'] = `Bearer ${lease.account.accessToken}`;
    if (lease.account.project) {
      retryHeaders['x-goog-user-project'] = lease.account.project;
    }

    let retryBody = reqBody;
    if (parsedBody && typeof parsedBody === 'object') {
      const cloned = { ...parsedBody };
      if (lease.account.project) {
        cloned.project = lease.account.project;
      }
      retryBody = Buffer.from(JSON.stringify(cloned), 'utf8');
    }
    retryHeaders['content-length'] = String(retryBody.length);
    if (nativeSubagent) retryHeaders['accept-encoding'] = 'identity';

    const isStreamHint = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
    const startedAt = Date.now();

    const outcome = await new Promise<{
      handled: boolean;
      succeeded: boolean;
    }>((resolve) => {
      const standbyReq = (options.requestFn || https.request)(
        parsedUrl,
        { method: req.method, headers: retryHeaders as Record<string, string> },
        async (standbyRes) => {
          const sc = standbyRes.statusCode || 200;
          if (sc >= 200 && sc < 300) {
            lease.release({ status: sc, latencyMs: Date.now() - startedAt });
            options.log?.info?.(
              `[Proxy] Standby account "${lease.account.label || lease.account.id}" succeeded with status ${sc}.`
            );
            if (nativeSubagent) {
              try {
                await forwardNativeGeneration(standbyRes, res, nativeSubagent, isStreamHint);
              } catch (e) {
                options.log?.error?.('[Proxy] Standby native generation forwarding failed:', e);
              }
            } else {
              res.writeHead(sc, options.forwardingHeaders(standbyRes.headers));
              standbyRes.pipe(res);
            }
            resolve({ handled: true, succeeded: true });
          } else if (sc === 429 || sc === 403) {
            const subChunks: Buffer[] = [];
            standbyRes.on('data', (c) => {
              if (subChunks.length < 16) subChunks.push(c);
            });
            standbyRes.on('end', () => {
              const subBody = Buffer.concat(subChunks).toString('utf8');
              const subDecision = classifyGoogleRateLimit(subBody, standbyRes.headers['retry-after']);
              lease.release({
                status: sc,
                retryAfterMs: subDecision.retryAfterMs,
                cooldownReason: subDecision.reason,
              });
              resolve({ handled: false, succeeded: false });
            });
          } else {
            // Other status code (e.g. 400 or 500)
            lease.release({ status: sc });
            res.writeHead(sc, options.forwardingHeaders(standbyRes.headers));
            standbyRes.pipe(res);
            resolve({ handled: true, succeeded: false });
          }
        },
      );

      standbyReq.on('error', (err) => {
        options.log?.error?.('[Proxy] Standby request error:', err);
        lease.release({ status: 502 });
        resolve({ handled: false, succeeded: false });
      });

      res.once('close', () => {
        standbyReq.destroy();
        lease.release({ cancelled: true });
      });

      standbyReq.end(retryBody);
    });

    if (outcome.handled) {
      return true;
    }

    // Exclude the account that just failed and loop
    candidates = candidates.filter((a) => a.id !== lease.account.id);
  }

  return false;
}
