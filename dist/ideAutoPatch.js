"use strict";
/**
 * Startup IDE auto-patch step for the Standalone_Service (Requirement 8).
 *
 * `runIdeAutoPatch()` calls OmniNorm's `defaultIdeAutoPatcher.ensurePatched({ port })` (or a
 * caller-supplied replacement) once, reports a skipped or failed patch with a single
 * `console.warn`, and never throws, so a patch problem never blocks service startup.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadDefaultPatcher = loadDefaultPatcher;
exports.describePatchSkip = describePatchSkip;
exports.describePatchFailure = describePatchFailure;
exports.runIdeAutoPatch = runIdeAutoPatch;
const WARN_SKIPPED = '[OmniNorm] IDE auto-patch skipped:';
const WARN_FAILED = '[OmniNorm] IDE auto-patch failed:';
const NO_REASON = 'no reason given';
/**
 * Default loader. With `module: commonjs`, tsc lowers this `import()` to a lazy `require()`,
 * which works because scripts/ide.mjs (imported by ideAutoPatcher.mjs) has no top-level await.
 */
async function loadDefaultPatcher() {
    const mod = await Promise.resolve().then(() => __importStar(require('./norm/ideAutoPatcher.mjs')));
    return (options) => mod.defaultIdeAutoPatcher.ensurePatched(options);
}
/** `reason` if defined, otherwise `error` if defined, otherwise a "no reason given" string (R8.4). */
function describePatchSkip(result) {
    const detail = result && typeof result === 'object' ? (result.reason ?? result.error) : undefined;
    return detail ?? NO_REASON;
}
/** `message` of an Error, otherwise `String(value)` (R8.5). */
function describePatchFailure(value) {
    return value instanceof Error ? value.message : String(value);
}
/**
 * Runs the auto-patch step once. Never throws and emits at most one `console.warn`.
 * - `setting === false`: does nothing (no import, no warning) (R8.10).
 * - `setting` is a function: calls it instead of loading the default patcher (R8.9).
 * - otherwise: loads the default patcher through `load` and calls it with `{ port }` (R8.1).
 */
async function runIdeAutoPatch(setting, port, load = loadDefaultPatcher) {
    if (setting === false)
        return;
    let result;
    try {
        const patch = typeof setting === 'function' ? setting : await load();
        result = await patch({ port });
    }
    catch (error) {
        console.warn(WARN_FAILED, describePatchFailure(error));
        return;
    }
    if (result?.ok === true)
        return;
    console.warn(WARN_SKIPPED, describePatchSkip(result));
}
//# sourceMappingURL=ideAutoPatch.js.map