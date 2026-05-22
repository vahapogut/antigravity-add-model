import { type BrowserWindowInstance } from 'electron';
export declare let showQuitConfirmation: boolean;
export declare function setShowQuitConfirmation(value: boolean): void;
export declare function isMacOS(): boolean;
/**
 * Creates and returns a new BrowserWindow pointed at `url`.
 * Uses a hidden title bar with native traffic lights on macOS.
 * Node integration is disabled and context isolation is enabled for security.
 */
export declare function createWindow(url: string): BrowserWindowInstance;
/**
 * Focuses a window if it exists, or creates a new one.
 */
export declare const showOrCreateWindow: (port: number) => void;
/**
 * Manages the power save blocker to keep the computer awake.
 */
export declare class SleepBlocker {
    private static instance;
    private currentBlockerId;
    static getInstance(): SleepBlocker;
    shouldKeepComputerAwake(keep: boolean | undefined): void;
}
interface NodeWrapperPaths {
    newEnvPath: string;
    nodeWrapperPath: string | undefined;
    binPath: string | undefined;
}
export declare function getNodeWrapperPaths(envPath: string, os: string, isPackaged: boolean, userDataPath: string, baseDir: string): NodeWrapperPaths;
/**
 * Sets up a wrapper script for Node.js that runs Electron as Node.
 * This allows running standard Node scripts using the Electron binary.
 */
export declare function setupNodeWrapper(env: Record<string, string | undefined>): void;
export {};
//# sourceMappingURL=utils.d.ts.map