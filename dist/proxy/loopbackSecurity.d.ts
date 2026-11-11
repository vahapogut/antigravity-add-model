import type { IncomingMessage, ServerResponse } from 'node:http';
/** Native language-server callers omit Origin; browser callers must use an owned origin. */
export declare function guardLoopbackRequest(req: IncomingMessage, res: ServerResponse, languageServerPort?: number): boolean;
/** The desktop supplies its current LS port, never a port learned from an HTTP caller. */
export declare function languageServerModelsUrl(value: string, port?: number): URL | undefined;
/** Incoming Google credentials may only accompany HTTPS downloads from Google API hosts. */
export declare function authenticatedGoogleFileUrl(value: string): URL | undefined;
/** Converting a file URL must never turn an attachment into a remote SMB read. */
export declare function localFilePath(url: URL): string;
//# sourceMappingURL=loopbackSecurity.d.ts.map