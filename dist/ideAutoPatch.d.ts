/**
 * Startup IDE auto-patch step for the Standalone_Service (Requirement 8).
 *
 * `runIdeAutoPatch()` calls OmniNorm's `defaultIdeAutoPatcher.ensurePatched({ port })` (or a
 * caller-supplied replacement) once, reports a skipped or failed patch with a single
 * `console.warn`, and never throws, so a patch problem never blocks service startup.
 */
/**
 * Result of `IdeAutoPatcher.ensurePatched()` in src/norm/ideAutoPatcher.mjs:
 * `{ ok: true, ideVersion, endpoint, applied, status, repaired, message, ... }` on success,
 * `{ ok: false, reason: 'IDE_NOT_FOUND', detected }` when no IDE is installed, and
 * `{ ok: false, ideVersion, commit, error }` when inspecting or configuring the IDE fails.
 */
export interface PatchResult {
    ok: boolean;
    reason?: string;
    error?: string;
    [key: string]: unknown;
}
export type IdeAutoPatchFn = (options: {
    port: number;
}) => PatchResult | Promise<PatchResult>;
/** `false` disables the step, a function replaces the default patcher, `undefined` uses the default. */
export type IdeAutoPatchSetting = false | IdeAutoPatchFn | undefined;
/**
 * Default loader. With `module: commonjs`, tsc lowers this `import()` to a lazy `require()`,
 * which works because scripts/ide.mjs (imported by ideAutoPatcher.mjs) has no top-level await.
 */
export declare function loadDefaultPatcher(): Promise<IdeAutoPatchFn>;
/** `reason` if defined, otherwise `error` if defined, otherwise a "no reason given" string (R8.4). */
export declare function describePatchSkip(result: Partial<PatchResult> | null | undefined): string;
/** `message` of an Error, otherwise `String(value)` (R8.5). */
export declare function describePatchFailure(value: unknown): string;
/**
 * Runs the auto-patch step once. Never throws and emits at most one `console.warn`.
 * - `setting === false`: does nothing (no import, no warning) (R8.10).
 * - `setting` is a function: calls it instead of loading the default patcher (R8.9).
 * - otherwise: loads the default patcher through `load` and calls it with `{ port }` (R8.1).
 */
export declare function runIdeAutoPatch(setting: IdeAutoPatchSetting, port: number, load?: () => Promise<IdeAutoPatchFn>): Promise<void>;
//# sourceMappingURL=ideAutoPatch.d.ts.map