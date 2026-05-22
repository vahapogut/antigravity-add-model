/**
 * IDE Install Service — Download, extract, copy, and launch logic.
 */
export declare function downloadFile(url: string, destPath: string, onProgress?: (percent: number) => void, maxRedirects?: number): Promise<void>;
export declare function extractIde(archivePath: string, installPath: string): Promise<void>;
export declare function copyUserData(sourcePath: string, destPath: string): Promise<void>;
export declare function downloadAndInstallIde(): Promise<void>;
//# sourceMappingURL=service.d.ts.map