import { ChildProcess } from 'child_process';
export declare const LS_BINARY: string;
export interface LanguageServerHandle {
    port: number;
    process: ChildProcess;
    exitPromise: Promise<ExitInfo>;
}
export interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
    crashStackTrace: string | undefined;
}
export interface StartMonitorOptions {
    headless?: boolean;
    onPortChanged?: (newPort: number) => void;
}
/**
 * Gets the build CL of the language server by running it with --stamp.
 */
export declare function getLsCL(): Promise<string>;
/** Returns the active language server process, or null if not running. */
export declare function getLsProcess(): ChildProcess | null;
/** Returns the active language server port, or 0 if not running. */
export declare function getLsPort(): number;
/** Clears the language server process reference (call after killing it). */
export declare function clearLsProcess(): void;
/**
 * Best-effort extraction of the crash stack trace from buffered stderr.
 * Returns the stack trace string, or undefined if no trigger phrase was found.
 */
export declare function extractCrashStackTrace(stderr: string): string | undefined;
/**
 * Spawn the language server and resolve with a LanguageServerHandle once
 * the LS reports its HTTP port. Rejects on timeout or unexpected exit
 * during startup.
 *
 * After resolving, callers should monitor `handle.exitPromise` to detect
 * crashes that occur after startup.
 */
export declare function startLanguageServer(port: number, csrf: string, headless?: boolean): Promise<LanguageServerHandle>;
/** Sets whether the termination was intentional (suppresses crash reports). */
export declare function setIntentionalTermination(value: boolean): void;
/**
 * Start the language server AND set up the restart monitoring loop.
 * Resolves with the handle on first successful startup.
 */
export declare function startAndMonitorLanguageServer(port: number, csrf: string, options?: StartMonitorOptions): Promise<LanguageServerHandle>;
export declare function killLanguageServer(): Promise<void>;
/**
 * Sets up certificate verification in Electron to trust the local self-signed cert
 * used by the language server. It verifies that the certificate fingerprint matches
 * the hardcoded `LS_CERT_FINGERPRINT`.
 *
 * TODO: Generate the cert.pem file dynamically
 */
export declare function setupLocalCertTrust(): void;
//# sourceMappingURL=languageServer.d.ts.map