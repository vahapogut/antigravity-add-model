/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */
export interface GeminiParameterProperties {
    type?: string;
    properties?: GeminiParameterProperties;
    items?: GeminiParameterProperties;
    [key: string]: unknown;
}
export interface ToolCallArgs {
    CommandLine?: string;
    Cwd?: string;
    [key: string]: unknown;
}
export interface TranslatedToolCall {
    name: string;
    args: Record<string, unknown>;
}
export interface TranslatedCallInfo {
    originalName: string;
    translatedName: string;
    cmd: string;
    cwd?: string;
}
export interface MatchResult {
    Filename: string;
    LineNumber: number;
    LineContent: string;
}
export interface DirectoryItem {
    name: string;
    isDir: boolean;
    sizeBytes?: number;
}
export interface FileListResponse {
    files?: DirectoryItem[];
    children?: DirectoryItem[];
    content?: string;
    CodeContent?: string;
}
export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;
/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export declare function fixParamTypes(properties: Record<string, unknown> | undefined): void;
/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
export declare function translateToolCallToNative(name: string, args: ToolCallArgs): TranslatedToolCall;
/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
export declare function formatTranslatedResponse(translatedInfo: TranslatedCallInfo, responseData: unknown): string;
//# sourceMappingURL=utils.d.ts.map