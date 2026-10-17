export interface ChatContextUsage {
    conversationId: string;
    currentTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
}
export interface ModelContextLookupEntry {
    name?: string;
    displayName?: string;
    externalModelName?: string;
    contextWindow?: number;
    nativeContextWindow?: number;
}
export interface ChatContextOptions {
    title?: string;
    fallbackToLatest?: boolean;
}
export declare function findLatestConversationId(brainDir: string): string | null;
export declare function findConversationIdByTitle(title?: string, customDbPath?: string): string | null;
export declare function getChatContextUsage(convId?: string, overrideBrainDir?: string, options?: ChatContextOptions): ChatContextUsage;
export declare function normalizeModelName(str?: string): string;
export declare function cleanModelSlug(s?: string): string;
export declare function resolveModelContextLimit(modelName?: string, customModels?: ModelContextLookupEntry[]): number | undefined;
export declare function fetchContextLimitFromApi(targetSlug: string): Promise<number | undefined>;
export declare function updateCustomModelContextWindow(modelName: string, contextWindow: number, customDbPath?: string): boolean;
export declare function formatTokenCount(tokens: number): string;
export declare function formatContextUnit(tokens: number): string;
export declare function formatContextTooltip(currentTokens: number, maxTokens?: number): string;
//# sourceMappingURL=chatContext.d.ts.map