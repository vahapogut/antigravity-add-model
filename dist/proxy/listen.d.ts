import type { Server } from 'http';
import { createServer as createNetServer } from 'net';
/** The optional binary patch cannot follow the language server's dynamic port flag. */
export declare function getRequiredProxyPort(appPath: string): number | undefined;
export declare function listenProxy(server: Server, preferredPort?: number, allowFallback?: boolean, createCompanion?: typeof createNetServer): Promise<number>;
//# sourceMappingURL=listen.d.ts.map