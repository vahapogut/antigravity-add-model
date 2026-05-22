/**
 * Preload script — runs in every BrowserWindow before the page loads.
 * Exposes a minimal, secure API via contextBridge so the renderer can
 * communicate with the main-process auto-updater without nodeIntegration.
 */
interface UpdaterState {
    type: string;
    update?: {
        version: string;
    };
}
type UnsubscribeFn = () => void;
interface UpdaterAPI {
    onStateChanged: (callback: (state: UpdaterState) => void) => UnsubscribeFn;
    applyUpdate: () => Promise<void>;
    quitAndInstall: () => Promise<void>;
    checkForUpdates: () => Promise<void>;
}
interface DialogAPI {
    showOpenDialog: () => Promise<string | undefined>;
}
interface NotificationOptions {
    title: string;
    body: string;
    silent?: boolean;
    payload?: unknown;
}
interface NotificationAPI {
    send: (options: NotificationOptions) => Promise<void>;
    openSystemPreferences: () => Promise<void>;
    onClicked: (callback: (payload: unknown) => void) => UnsubscribeFn;
}
interface StorageAPI {
    getItems: () => Promise<Record<string, string | null>>;
    updateItems: (changes: Record<string, string | null>) => Promise<void>;
    onChanged: (callback: (changes: Record<string, string | null>) => void) => UnsubscribeFn;
    getCustomModels: () => Promise<CustomModelEntry[]>;
    saveCustomModel: (model: CustomModelEntry) => Promise<{
        success: boolean;
        error?: string;
    }>;
    deleteCustomModel: (modelName: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    testModelConnection: (model: TestModelParams) => Promise<ConnectionTestResult>;
}
interface LogsAPI {
    getElectronLogs: () => Promise<string>;
}
interface ExtensionsAPI {
    sendAuthorities: (authoritiesMap: Record<string, string>) => Promise<void>;
}
interface DeepLinkAPI {
    onDeepLink: (callback: (url: string) => void) => UnsubscribeFn;
    getStoredDeepLink: () => Promise<string | undefined>;
}
interface AgentAPI {
    updateActiveAgentCount: (count: number) => Promise<void>;
}
interface TitleBarOverlayOptions {
    color: string;
    symbolColor: string;
}
interface ElectronNativeAPI {
    getZoomLevel: () => number;
    setTitleBarOverlay: (options: TitleBarOverlayOptions) => Promise<void>;
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    unmaximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    close: () => Promise<void>;
    toggleDevTools: () => Promise<void>;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    openExternal: (url: string) => Promise<void>;
}
interface CustomModelEntry {
    name: string;
    displayName?: string;
    description?: string;
    provider: string;
    apiKey: string;
    apiUrl: string;
    externalModelName: string;
    allowUnauthorized?: boolean;
    encrypted?: boolean;
    [key: string]: unknown;
}
interface TestModelParams {
    apiUrl: string;
    provider: string;
    apiKey?: string;
    allowUnauthorized?: boolean;
}
interface ConnectionTestResult {
    success: boolean;
    status?: number;
    message?: string;
    error?: string;
}
declare global {
    interface Window {
        electronUpdater: UpdaterAPI;
        dialog: DialogAPI;
        nativeNotifications: NotificationAPI;
        nativeStorage: StorageAPI;
        logs: LogsAPI;
        extensions: ExtensionsAPI;
        deepLink: DeepLinkAPI;
        agent: AgentAPI;
        electronNative: ElectronNativeAPI;
    }
}
export {};
//# sourceMappingURL=preload.d.ts.map