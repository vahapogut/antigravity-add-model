export interface GeminiImagePart {
    inlineData?: {
        mimeType: string;
        data: string;
    };
    fileData?: {
        mimeType?: string;
        fileUri: string;
    };
}
type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type ImageSource = {
    type: 'base64';
    media_type: ImageMimeType;
    data: string;
} | {
    type: 'url';
    url: string;
};
export declare function hasImagePart(part: GeminiImagePart): boolean;
export declare function assertUserImageParts(parts: GeminiImagePart[], role: string): void;
/**
 * A function response may itself carry parts. The language server reports media
 * produced by a tool execution as `functionResponse.parts[].inlineData`, because
 * the response payload is a JSON Struct and cannot hold image bytes itself.
 */
export interface GeminiNestedFunctionResponse {
    parts?: GeminiImagePart[];
}
export declare function omitUnsupportedToolImages<T extends {
    contents?: unknown[];
}>(body: T, supportsImages: boolean): T;
export declare function nestedFunctionResponseParts(part: {
    functionResponse?: GeminiNestedFunctionResponse;
}): GeminiImagePart[];
/** Converting a file URL must never turn an attachment into a remote SMB read. */
export declare function localFilePath(url: URL): string;
/** Never fetch remote URLs here; the selected provider resolves them. */
export declare function getImageSource(part: GeminiImagePart): ImageSource | undefined;
export {};
//# sourceMappingURL=images.d.ts.map