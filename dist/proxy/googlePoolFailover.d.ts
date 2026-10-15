import type * as http from 'node:http';
import * as https from 'node:https';
import { type NativeSubagentRouting } from './nativeSubagentResponse';
export interface PoolFailoverOptions {
    loadCustomModels: () => any[];
    forwardingHeaders: (source: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders;
    cloudCodeRouting?: {
        resolve: (headers: http.IncomingHttpHeaders) => string;
    };
    log?: {
        info: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
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
export declare function attemptGooglePoolFailover(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer, errorRes: http.IncomingMessage, errorBody: string, options: PoolFailoverOptions, nativeSubagent?: NativeSubagentRouting, cloudCodeOrigin?: string): Promise<boolean>;
//# sourceMappingURL=googlePoolFailover.d.ts.map