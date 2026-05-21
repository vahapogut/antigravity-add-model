/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */
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
}
export declare function startProxy(): Promise<number>;
export declare function stopProxy(): Promise<void>;
export declare function getProxyPort(): number;
//# sourceMappingURL=proxy.d.ts.map