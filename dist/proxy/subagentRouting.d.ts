import type { GeminiBody } from './requestOptions';
export type SubagentModelResolver = (selector: string) => string | undefined;
export declare class SubagentRoutingError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export interface SubagentRoutingContext {
    readonly scope: string;
    readonly stable: boolean;
    readonly requestId: string;
    /** Set to the actual configured provider attempt before emitting its output. */
    modelName?: string;
    /** The incoming HTTP request's matched custom model before subagent override. */
    httpModelName?: string;
}
/**
 * Bridge the IDE's fixed subagent tiers at the common Gemini boundary. Provider
 * translators never own this state: history can switch providers at any turn.
 * Opaque, locally issued prompt markers route the very first child request,
 * before its parent receives the spawn tool result.
 */
export declare class SubagentRoutingBridge {
    private readonly calls;
    private readonly markers;
    private readonly bindings;
    /** Bounded scope-only tombstones prevent silent fallback after cache expiry. */
    private readonly expiredScopes;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    constructor(options?: {
        ttlMs?: number;
        maxEntries?: number;
        now?: () => number;
    });
    clear(): void;
    private prune;
    private requireMarker;
    private requireModel;
    private requireBoundModel;
    private validateBinding;
    private bind;
    prepareRequest(body: GeminiBody, resolve: SubagentModelResolver, requestModelName?: string): {
        body: GeminiBody;
        context: SubagentRoutingContext;
        modelName?: string;
    };
    private relaxTools;
    private restoreHistory;
    rewriteCandidate<T>(candidate: T, context: SubagentRoutingContext, resolve: SubagentModelResolver): T;
    rewriteResponse<T>(response: T, context: SubagentRoutingContext, resolve: SubagentModelResolver): T;
    private rewriteCall;
}
export declare const subagentRouting: SubagentRoutingBridge;
//# sourceMappingURL=subagentRouting.d.ts.map