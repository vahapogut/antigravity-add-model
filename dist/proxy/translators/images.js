"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasImagePart = hasImagePart;
exports.assertUserImageParts = assertUserImageParts;
exports.omitUnsupportedToolImages = omitUnsupportedToolImages;
exports.nestedFunctionResponseParts = nestedFunctionResponseParts;
exports.localFilePath = localFilePath;
exports.getImageSource = getImageSource;
/** Image inputs shared by the OpenAI and Anthropic request translators. */
const fs_1 = require("fs");
const url_1 = require("url");
function isImageMimeType(mimeType) {
    return typeof mimeType === 'string' && /^image\//i.test(mimeType.trim());
}
function hasImagePart(part) {
    return (isImageMimeType(part.inlineData?.mimeType) ||
        isImageMimeType(part.fileData?.mimeType) ||
        isImageDataUrl(part.fileData?.fileUri));
}
function isImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
}
function assertUserImageParts(parts, role) {
    if (role !== 'user' && parts.some(hasImagePart)) {
        throw new Error('Image inputs are only supported in user messages.');
    }
}
/**
 * Text-only providers reject an image with a hard failure (OpenRouter returns
 * "No endpoints found that support image input"), which fails the whole request
 * rather than just the image. Forwarding images out of tool results is new, so a
 * model that was working before the fix must not start failing because a tool
 * happened to read a PNG. For a model not advertised as vision capable, replace
 * the tool's image with a readable placeholder and keep the response text.
 *
 * Only nested `functionResponse.parts` media is touched. Top-level user images
 * already had their own path and keep their existing behaviour, so a vision model
 * that matches no name pattern and carries no explicit flag is never affected.
 */
const OMITTED = '[Image omitted: this model does not support image input.]';
function isImageAttachment(field, attachment) {
    if (!attachment || typeof attachment !== 'object')
        return false;
    return ((typeof attachment.mimeType === 'string' && /^image\//i.test(attachment.mimeType.trim())) ||
        (field === 'fileData' && typeof attachment.fileUri === 'string' && /^data:image\//i.test(attachment.fileUri)));
}
function hasImageAttachment(part) {
    return (isImageAttachment('inlineData', part.inlineData) || isImageAttachment('fileData', part.fileData));
}
function withoutImageAttachment(part) {
    const copy = { ...part };
    for (const field of ['inlineData', 'fileData']) {
        if (isImageAttachment(field, copy[field]))
            delete copy[field];
    }
    return copy;
}
function omitUnsupportedToolImages(body, supportsImages) {
    if (supportsImages)
        return body;
    const contents = body.contents;
    if (!Array.isArray(contents))
        return body;
    let changed = false;
    const mapped = contents.map((content) => {
        const item = content;
        if (!Array.isArray(item.parts))
            return content;
        let touched = false;
        const parts = item.parts.map((rawPart) => {
            const part = (rawPart || {});
            const response = part.functionResponse;
            if (!response || typeof response !== 'object' || !Array.isArray(response.parts))
                return rawPart;
            const nestedParts = response.parts.map((nested) => (nested || {}));
            if (!nestedParts.some(hasImageAttachment))
                return rawPart;
            touched = true;
            return { ...part, functionResponse: { ...response, parts: nestedParts.map(withoutImageAttachment) } };
        });
        if (!touched)
            return content;
        changed = true;
        // One placeholder per tool response, after the part that carried the image.
        return { ...item, parts: [...parts, { text: OMITTED }] };
    });
    return changed ? { ...body, contents: mapped } : body;
}
function nestedFunctionResponseParts(part) {
    const nested = part.functionResponse?.parts;
    return Array.isArray(nested) ? nested : [];
}
function imageMimeType(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'image/jpeg' ||
        normalized === 'image/png' ||
        normalized === 'image/gif' ||
        normalized === 'image/webp') {
        return normalized;
    }
    throw new Error('Unsupported image format. Use JPEG, PNG, GIF, or WebP.');
}
function imageBase64(data) {
    if (typeof data !== 'string')
        throw new Error('Invalid image input: expected base64 image data.');
    const normalized = data.replace(/\s/g, '');
    if (!normalized ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
        normalized.length % 4 === 1 ||
        (normalized.includes('=') && normalized.length % 4 !== 0)) {
        throw new Error('Invalid image input: expected base64 image data.');
    }
    return normalized;
}
/** Converting a file URL must never turn an attachment into a remote SMB read. */
function localFilePath(url) {
    const remoteFileError = 'Only local file URLs are supported; network shares are not allowed.';
    if (url.protocol !== 'file:' ||
        (url.hostname && url.hostname.toLowerCase() !== 'localhost') ||
        /^[\\/]{2}/.test(url.pathname)) {
        throw new Error(remoteFileError);
    }
    let localPath;
    try {
        localPath = (0, url_1.fileURLToPath)(url);
    }
    catch {
        throw new Error('Invalid local attachment file URL.');
    }
    if (/^[\\/]{2}/.test(localPath))
        throw new Error(remoteFileError);
    return localPath;
}
/** Never fetch remote URLs here; the selected provider resolves them. */
function getImageSource(part) {
    if (isImageMimeType(part.inlineData?.mimeType)) {
        const inline = part.inlineData;
        return { type: 'base64', media_type: imageMimeType(inline.mimeType), data: imageBase64(inline.data) };
    }
    if (!isImageMimeType(part.fileData?.mimeType) && !isImageDataUrl(part.fileData?.fileUri))
        return undefined;
    const file = part.fileData;
    if (isImageDataUrl(file.fileUri)) {
        const match = /^data:(image\/[^;,]+);base64,([\s\S]*)$/i.exec(file.fileUri);
        if (!match)
            throw new Error('Invalid image data URL. Use a base64-encoded JPEG, PNG, GIF, or WebP image.');
        const mediaType = imageMimeType(match[1]);
        if (file.mimeType && imageMimeType(file.mimeType) !== mediaType) {
            throw new Error('Invalid image input: the declared format does not match the image data URL.');
        }
        return { type: 'base64', media_type: mediaType, data: imageBase64(match[2]) };
    }
    const mediaType = imageMimeType(file.mimeType);
    let url;
    try {
        url = new URL(file.fileUri);
    }
    catch {
        throw new Error('Invalid image URL. Use a file, HTTP, or HTTPS URL.');
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (url.username || url.password)
            throw new Error('Image URLs must not contain embedded credentials.');
        return { type: 'url', url: file.fileUri };
    }
    if (url.protocol !== 'file:')
        throw new Error('Unsupported image URL. Use a file, HTTP, or HTTPS URL.');
    const localPath = localFilePath(url);
    let data;
    try {
        data = (0, fs_1.readFileSync)(localPath);
    }
    catch {
        // Filesystem errors include local paths; expose only a safe, actionable message.
        throw new Error('Unable to read the local image file. Check that it exists and is readable.');
    }
    if (!data.length)
        throw new Error('Invalid image input: the local image file is empty.');
    return { type: 'base64', media_type: mediaType, data: data.toString('base64') };
}
//# sourceMappingURL=images.js.map