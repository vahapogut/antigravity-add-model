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

export type IdeAutoPatchFn = (options: { port: number }) => PatchResult | Promise<PatchResult>;

/** `false` disables the step, a function replaces the default patcher, `undefined` uses the default. */
export type IdeAutoPatchSetting = false | IdeAutoPatchFn | undefined;

const WARN_SKIPPED = '[OmniNorm] IDE auto-patch skipped:';
const WARN_FAILED = '[OmniNorm] IDE auto-patch failed:';
const NO_REASON = 'no reason given';

/**
 * Default loader. With `module: commonjs`, tsc lowers this `import()` to a lazy `require()`,
 * which works because scripts/ide.mjs (imported by ideAutoPatcher.mjs) has no top-level await.
 */
export async function loadDefaultPatcher(): Promise<IdeAutoPatchFn> {
  const mod = await import('./norm/ideAutoPatcher.mjs');
  return (options) => mod.defaultIdeAutoPatcher.ensurePatched(options) as PatchResult;
}

/** `reason` if defined, otherwise `error` if defined, otherwise a "no reason given" string (R8.4). */
export function describePatchSkip(result: Partial<PatchResult> | null | undefined): string {
  const detail = result && typeof result === 'object' ? (result.reason ?? result.error) : undefined;
  return detail ?? NO_REASON;
}

/** `message` of an Error, otherwise `String(value)` (R8.5). */
export function describePatchFailure(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Runs the auto-patch step once. Never throws and emits at most one `console.warn`.
 * - `setting === false`: does nothing (no import, no warning) (R8.10).
 * - `setting` is a function: calls it instead of loading the default patcher (R8.9).
 * - otherwise: loads the default patcher through `load` and calls it with `{ port }` (R8.1).
 */
export async function runIdeAutoPatch(
  setting: IdeAutoPatchSetting,
  port: number,
  load: () => Promise<IdeAutoPatchFn> = loadDefaultPatcher,
): Promise<void> {
  if (setting === false) return;

  let result: PatchResult | undefined;
  try {
    const patch = typeof setting === 'function' ? setting : await load();
    result = await patch({ port });
  } catch (error) {
    console.warn(WARN_FAILED, describePatchFailure(error));
    return;
  }

  if (result?.ok === true) return;
  console.warn(WARN_SKIPPED, describePatchSkip(result));
}
