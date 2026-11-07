/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */
import * as http from 'http';
export interface CustomModel {
    name: string;
    displayName: string;
    description: string;
    provider: string;
    apiKey: string;
    apiUrl: string;
    externalModelName: string;
    allowUnauthorized?: boolean;
    encrypted?: boolean;
    _slug?: string;
    timeout?: number;
    maxRetries?: number;
    enabled?: boolean;
    apiFormat?: import('./providers').ApiFormat;
    fallbackModels?: string[];
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    compactionReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    compactionThresholdPercent?: number;
    thinkingBudget?: number;
    maxOutputTokens?: number;
    contextWindow?: number;
    idleTimeout?: number;
    retryBudgetMs?: number;
    circuitBreaker?: import('./proxy/circuitBreaker').CircuitBreakerOptions;
    customHeaders?: Record<string, string>;
    encryptedHeaders?: boolean;
    extraBody?: Record<string, unknown>;
    /** Extra instructions appended after Antigravity's own system instruction for this model. */
    systemPrompt?: string;
    rawUrl?: boolean;
    gateway?: boolean;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    googleProject?: string;
    googleAccounts?: import('./googleAccounts').GoogleAccount[];
    googlePool?: import('./googleAccounts').GooglePoolOptions;
    encryptedGoogleAccounts?: boolean;
}
export interface ProxyStartOptions {
    /** Fixed loopback port for the IDE service; no automatic port fallback. */
    port?: number;
    dataDirectory?: string;
    /** Addon-owned HTTP management routes. Return true when handled. */
    handleManagement?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
    /** IDE service has no owned desktop LS; never reuse desktop routing/origin exceptions. */
    allowLanguageServerRouting?: boolean;
    /** Bound draining of unfinished requests on shutdown (default 1500 ms). */
    shutdownGraceMs?: number;
    /** IDE account bootstrap uses PROD, then the account's declared Cloud Code tier. */
    ideCloudCodeRouting?: boolean;
}
/** Registered by the desktop with its own live language-server port getter. */
export declare function setLanguageServerPortResolver(resolve: () => number | undefined): void;
export declare function loadCustomModels(): CustomModel[];
export declare function startProxy(options?: ProxyStartOptions): Promise<number>;
export declare function stopProxy(): Promise<void>;
export declare function getProxyPort(): number;
//# sourceMappingURL=proxy.d.ts.map