import { GoogleNativeClient } from './googleNativeClient';
export declare const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export declare const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export interface GoogleLoginOptions {
    authMode?: 'custom' | 'antigravity';
    clientId?: string;
    clientSecret?: string;
    label?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface GoogleLoginAccount {
    authMode?: 'custom' | 'antigravity';
    id: string;
    label?: string;
    email?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    clientId: string;
    clientSecret?: string;
}
interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
}
export declare function parseGoogleIdToken(idToken?: string): {
    email?: string;
    name?: string;
} | undefined;
export declare function fetchGoogleUserInfo(accessToken: string, signal?: AbortSignal): Promise<{
    email?: string;
    name?: string;
}>;
export interface GoogleOAuthDependencies {
    /** Dependency injection is for local protocol tests; production always uses Google's fixed token URL. */
    exchangeToken?: (parameters: URLSearchParams, signal: AbortSignal) => Promise<TokenResponse>;
    now?: () => number;
    resolveNativeClient?: () => GoogleNativeClient;
}
/** Returns credentials to the main process only. IPC callers must store them before returning a redacted account. */
export declare function loginGoogleAccount(options: GoogleLoginOptions, openExternal: (url: string) => Promise<unknown>, dependencies?: GoogleOAuthDependencies): Promise<GoogleLoginAccount>;
export {};
//# sourceMappingURL=googleOAuth.d.ts.map