import { ModelStore, ModelEntry, SecretCodec } from './modelStore';
import { loginGoogleAccount, GoogleLoginOptions } from './googleOAuth';
import { prepareGoogleAccount } from './googleOnboarding';
import { GoogleAccount, GooglePoolOptions, refreshGoogleAccount, fetchGoogleQuota } from './googleAccounts';
export interface ProbeParams {
    name?: string;
    provider: string;
    apiUrl: string;
    apiKey?: string;
    apiFormat?: 'openai' | 'anthropic' | 'google';
    externalModelName?: string;
    allowUnauthorized?: boolean;
    customHeaders?: Record<string, string>;
    googleAccounts?: GoogleAccount[];
    googleProject?: string;
    googlePool?: GooglePoolOptions;
}
export interface GatewayConnection {
    url: string;
    token?: string;
    dashboardUrl?: string;
}
export interface DiscoveredModel {
    id: string;
    displayName: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
}
export declare function checkedUrl(value: string): URL;
/** Small bounded requests, no credential forwarding across redirects. */
export declare function requestJson(urlValue: string, headers?: Record<string, string>, allowUnauthorized?: boolean): Promise<{
    status: number;
    data: unknown;
}>;
export declare function modelListUrl(apiUrl: string, format: string, provider?: string): string;
export declare function createModelManager(directory: string, codec: SecretCodec, openExternal: (url: string) => Promise<unknown>, overrides?: Partial<{
    loginGoogleAccount: typeof loginGoogleAccount;
    refreshGoogleAccount: typeof refreshGoogleAccount;
    fetchGoogleQuota: typeof fetchGoogleQuota;
    prepareGoogleAccount: typeof prepareGoogleAccount;
    now: () => number;
}>): {
    store: ModelStore;
    saveModel: (model: ModelEntry) => {
        success: boolean;
    };
    presets: () => readonly import("./providers").ProviderPreset[];
    discoverModels: (input: ProbeParams) => Promise<{
        success: boolean;
        models: {
            id: string;
            displayName: string;
        }[];
        status: number;
    }>;
    createEffortVariants(name: string): {
        success: boolean;
        count: number;
    };
    googleLogin(options: GoogleLoginOptions): Promise<{
        success: boolean;
        account: GoogleAccount;
    }>;
    googleLoginCancel(): {
        success: boolean;
    };
    googlePoolStatus(): {
        success: boolean;
        accounts: {
            id: string;
            label: string;
            inFlight: number;
            status: string;
            cooldownUntil: number;
            modelCooldowns: {
                modelName: string;
                cooldownUntil: number;
                reason: import("./googlePoolPolicy").GoogleCooldownReason;
            }[];
            requests: number;
            succeeded: number;
            failed: number;
            avgLatencyMs: number;
            lastStatus: number;
            lastError: {
                category: import("./googleAccessErrors").GoogleAccessErrorCategory;
                message: string;
            };
            quotaAgeMs: number;
            quotaFresh: boolean;
            quotaExhausted: boolean;
            quota: import("./googleAccounts").GoogleQuotaSnapshot;
        }[];
    };
    googleLinkAccount(input: {
        modelName: string;
        accountId: string;
        replaceAccountId?: string;
    }): {
        success: boolean;
        count: number;
    };
    googleSelectAccount(input: {
        modelName: string;
        accountId?: string;
    }): {
        success: boolean;
        count: number;
    };
    googleRemoveAccount(input: {
        modelName: string;
        accountId: string;
    }): {
        success: boolean;
        count: number;
    };
    googlePrepareAccount(input: {
        modelName?: string;
        accountId?: string;
        account?: GoogleAccount;
        allowOnboard?: boolean;
    }): Promise<{
        success: boolean;
        account: GoogleAccount;
        message: string;
    }>;
    googleTestAccount(input: {
        modelName?: string;
        accountId?: string;
        account?: GoogleAccount;
    }): Promise<{
        success: boolean;
        quota: import("./googleAccounts").GoogleQuotaSnapshot;
    }>;
    testModel(input: ProbeParams): Promise<{
        success: boolean;
        status: number;
        error: string;
        message?: undefined;
    } | {
        success: boolean;
        status: number;
        message: string;
        error?: undefined;
    }>;
    testGeneration(input: ProbeParams): Promise<{
        success: boolean;
        status: number;
        error: string;
        message?: undefined;
    } | {
        success: boolean;
        status: number;
        message: string;
        error?: undefined;
    }>;
    discoverLocal(): Promise<{
        success: boolean;
        servers: {
            provider: string;
            apiUrl: string;
            models: DiscoveredModel[];
        }[];
    }>;
    getGateway(): {
        token: string;
        url: string;
        dashboardUrl?: string;
    };
    saveGateway(input: GatewayConnection): {
        success: boolean;
    };
    testGateway(input?: GatewayConnection): Promise<{
        success: boolean;
        message: string;
        models: DiscoveredModel[];
    }>;
    importGatewayModels(input?: GatewayConnection): Promise<{
        success: boolean;
        count: number;
    }>;
    openDashboard(): Promise<{
        success: boolean;
    }>;
};
//# sourceMappingURL=modelManagement.d.ts.map