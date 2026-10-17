import * as http from 'node:http';
import type { CustomModel } from '../proxy';
import { type NativeSubagentRouting } from './nativeSubagentResponse';
type PoolModel = Pick<CustomModel, 'name' | 'provider' | 'externalModelName' | 'googleAccounts' | 'googlePool'> & Partial<Pick<CustomModel, 'enabled' | 'apiUrl' | 'timeout' | 'retryBudgetMs'>>;
export interface PoolFailoverOptions {
    loadCustomModels: () => PoolModel[];
    forwardingHeaders: (source: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders;
    trackUpstream?: (request: http.ClientRequest) => void;
    isStopping?: () => boolean;
    /** Dependency injection for local transport tests. */
    requestFn?: typeof http.request;
    timeoutMs?: number;
    log?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
    };
}
/** No global credential aggregation: only one explicitly opted-in matching model is eligible. */
export declare function resolveGoogleFailoverPool(models: PoolModel[], body: Buffer, reqUrl?: string): PoolModel | undefined;
/** HTTP 429, 403, and 400 are quota failures if structured or containing rate limit text. */
export declare function isGoogleQuotaFailure(status: number, body: string): boolean;
/** Retry matching native Google requests only before downstream response headers are sent. */
export declare function attemptGooglePoolFailover(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer, errorRes: http.IncomingMessage, errorBody: string, options: PoolFailoverOptions, nativeSubagent?: NativeSubagentRouting, cloudCodeOrigin?: string): Promise<boolean>;
export {};
//# sourceMappingURL=googlePoolFailover.d.ts.map