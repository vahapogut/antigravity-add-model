import { type IdeAutoPatchFn } from './ideAutoPatch';
export interface ServiceOptions {
    port: number;
    dataDirectory: string;
    token: string;
    instance: string;
    onStop?: () => void;
    /**
     * Startup IDE auto-patch step, run once after the proxy is listening.
     * `false` disables it; a function replaces OmniNorm's `ensurePatched({ port })`;
     * omitted uses the default patcher. Failures only log a warning.
     */
    ideAutoPatch?: false | IdeAutoPatchFn;
}
export declare function startStandaloneService(options: ServiceOptions): Promise<{
    port: number;
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=standaloneService.d.ts.map