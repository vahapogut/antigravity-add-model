import type { CustomModel } from './proxy';
/**
 * Output budget for "Test generation". Reasoning models (for example Qwen3 or
 * DeepSeek-R1 behind llama.cpp) spend tokens on reasoning before the answer, so a
 * tiny budget fails them even though they work in chat (issue #42). Other models
 * still stop after replying "OK", so the larger limit does not raise their cost.
 */
export declare const GENERATION_PROBE_OUTPUT_TOKENS = 1024;
/** Explicitly invoked only. One short generation; no retries, tools, user prompt or fallback models. */
export declare function runGenerationProbe(input: CustomModel): Promise<{
    success: boolean;
    status: number;
    error: string;
    message?: undefined;
} | {
    success: boolean;
    status: number;
    message: string;
    error?: undefined;
}>;
//# sourceMappingURL=generationProbe.d.ts.map