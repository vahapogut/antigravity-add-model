"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapGeminiToOpenAI = mapGeminiToOpenAI;
exports.mapOpenAIToGemini = mapOpenAIToGemini;
exports.mapOpenAIChunkToGemini = mapOpenAIChunkToGemini;
exports.mapGeminiToolsToOpenAI = mapGeminiToolsToOpenAI;
/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */
const fs_1 = require("fs");
const electron_log_1 = __importDefault(require("electron-log"));
const images_1 = require("./images");
const utils_1 = require("./utils");
const shared_1 = require("../shared");
// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────
function mapUserContentParts(parts) {
    const content = [];
    for (const part of parts) {
        const image = (0, images_1.getImageSource)(part);
        if (image) {
            content.push({
                type: 'image_url',
                image_url: { url: image.type === 'url' ? image.url : `data:${image.media_type};base64,${image.data}` },
            });
        }
        else if (part.text) {
            content.push({ type: 'text', text: part.text });
        }
        else if (part.fileData) {
            const file = part.fileData;
            let text = `[File reference: ${file.fileUri} (${file.mimeType})]`;
            let url;
            try {
                url = new URL(file.fileUri);
            }
            catch {
                // Preserve the existing reference fallback for non-image files.
            }
            if (url?.protocol === 'file:') {
                const localPath = (0, images_1.localFilePath)(url);
                try {
                    text = `[File content from ${file.fileUri}]:\n${(0, fs_1.readFileSync)(localPath, 'utf-8')}`;
                }
                catch {
                    // Preserve the reference fallback for unreadable local text files.
                }
            }
            content.push({ type: 'text', text });
        }
        else if (part.inlineData) {
            content.push({
                type: 'text',
                text: `[Inline data: ${part.inlineData.mimeType}, length: ${(part.inlineData.data || '').length} chars]`,
            });
        }
    }
    return content;
}
function compactContent(parts) {
    // Any image forces the parts array; otherwise a tool result would collapse to text.
    return parts.some((part) => part.type === 'image_url')
        ? parts
        : parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}
function mapAssistantMessage(parts) {
    let content = '';
    let reasoning = '';
    for (const part of parts) {
        if (part.thought)
            reasoning += part.text || '';
        else
            content += part.text || '';
    }
    // Replay reasoning from this history item for both ordinary and tool-call turns.
    return { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
}
function mapGeminiToolsToOpenAI(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools))
        return [];
    const openaiTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const declaration = func.parametersJsonSchema ?? func.parameters;
                const params = (0, utils_1.normalizeToolSchema)(declaration ?? { type: 'object', properties: {} });
                openaiTools.push({
                    type: 'function',
                    function: {
                        name: func.name,
                        description: func.description || '',
                        parameters: params,
                    },
                });
            }
        }
    }
    return openaiTools;
}
function mapGeminiToOpenAI(geminiBody, modelName, stateKey = modelName) {
    const messages = [];
    const historyCallIds = new Map();
    const pendingToolResponseContent = [];
    const flushToolResponseContent = () => {
        if (!pendingToolResponseContent.length)
            return;
        messages.push({ role: 'user', content: compactContent([...pendingToolResponseContent]) });
        pendingToolResponseContent.length = 0;
    };
    if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
        (0, images_1.assertUserImageParts)(geminiBody.systemInstruction.parts, 'system');
        const systemText = geminiBody.systemInstruction.parts.map((p) => p.text || '').join('');
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            if (item.parts) {
                (0, images_1.assertUserImageParts)(item.parts, item.role || 'user');
                const hasFunctionCall = item.parts.some((p) => p.functionCall);
                const hasFunctionResponse = item.parts.some((p) => p.functionResponse);
                if (!hasFunctionResponse)
                    flushToolResponseContent();
                if (hasFunctionCall && item.role === 'model') {
                    const toolCalls = [];
                    for (const p of item.parts) {
                        if (p.functionCall) {
                            const callId = p.functionCall.id || 'call_' + Math.random().toString(36).slice(2, 10);
                            const ids = historyCallIds.get(p.functionCall.name) || [];
                            ids.push(callId);
                            historyCallIds.set(p.functionCall.name, ids);
                            let originalName = p.functionCall.name;
                            let originalArgs = p.functionCall.args;
                            const translatedInfo = shared_1.translatedToolCalls.get(callId);
                            if (translatedInfo) {
                                originalName = translatedInfo.originalName;
                                originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
                            }
                            toolCalls.push({
                                id: callId,
                                type: 'function',
                                function: {
                                    name: originalName,
                                    arguments: typeof originalArgs === 'string' ? originalArgs : JSON.stringify(originalArgs || {}),
                                },
                            });
                        }
                    }
                    const message = mapAssistantMessage(item.parts);
                    message.content = message.content || null;
                    message.tool_calls = toolCalls;
                    messages.push(message);
                }
                else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        if (!p.thought)
                            pendingToolResponseContent.push(...mapUserContentParts([p]));
                        if (p.functionResponse) {
                            // Tool media arrives as nested parts, not as top-level image parts.
                            // They cannot live in an OpenAI tool message, so forward them as a
                            // native image in the user turn that accompanies the tool results.
                            const nested = (0, images_1.nestedFunctionResponseParts)(p);
                            if (nested.length) {
                                // A top-level inlineData/fileData would only yield a placeholder here;
                                // images must be translated from the nested parts themselves.
                                const nestedContent = mapUserContentParts(nested);
                                if (nestedContent.length)
                                    pendingToolResponseContent.push(...nestedContent);
                            }
                            const funcName = p.functionResponse.name || '';
                            const modelTCIds = shared_1.modelToolCallIds.get(stateKey) || {};
                            const ids = historyCallIds.get(funcName) || [];
                            const toolCallId = p.functionResponse.id || ids.shift() || modelTCIds[funcName] || 'call_' + funcName;
                            if (p.functionResponse.id) {
                                const matched = ids.indexOf(p.functionResponse.id);
                                if (matched >= 0)
                                    ids.splice(matched, 1);
                            }
                            const responseData = p.functionResponse.response;
                            let contentStr = '';
                            const translatedInfo = shared_1.translatedToolCalls.get(toolCallId);
                            if (translatedInfo) {
                                contentStr = (0, utils_1.formatTranslatedResponse)(translatedInfo, responseData);
                            }
                            else {
                                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
                            }
                            messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
                        }
                    }
                }
                else {
                    const role = item.role === 'model' ? 'assistant' : item.role || 'user';
                    if (role === 'assistant') {
                        messages.push(mapAssistantMessage(item.parts));
                    }
                    else {
                        messages.push({ role, content: compactContent(mapUserContentParts(item.parts)) });
                    }
                }
            }
        }
    }
    // Keep feedback after all consecutive tool results, including split parallel responses.
    flushToolResponseContent();
    // Inject reasoning_content into assistant messages missing it
    let lastAssistantIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant')
            lastAssistantIdx = i;
    }
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && !messages[i].reasoning_content) {
            const preservedReasoning = shared_1.modelReasoningContent.get(stateKey) || '';
            messages[i].reasoning_content = i === lastAssistantIdx && preservedReasoning ? preservedReasoning : '';
        }
    }
    // Models requiring max_completion_tokens instead of max_tokens:
    // - Legacy o-series: o1, o3, o4-mini (any format: o1, o1-mini, openai/o3, etc.)
    // - Legacy gpt-4.1 series: gpt-4.1, 4.1-mini, gpt-4.1-nano (any prefix)
    // - GPT-5.x thinking/pro: gpt-5.4-thinking, gpt-5.5-pro, etc.
    //   (OpenAI unified under GPT-5.x in Feb 2026, deprecated all previous models)
    const lowerName = modelName.toLowerCase();
    const isThinkingModel = /thinking|reasoning/i.test(lowerName);
    const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
    const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
    const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
    const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
    const needsCompletionTokens = isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
    const needsNoTemperature = isThinkingModel || isReasoningModel;
    const maxTokens = geminiBody.generationConfig?.maxOutputTokens ?? 4000;
    const payload = {
        model: modelName,
        messages,
        ...(needsNoTemperature ? {} : { temperature: geminiBody.generationConfig?.temperature ?? 0.7 }),
        ...(needsCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    };
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
        const openaiTools = mapGeminiToolsToOpenAI(geminiBody.tools);
        if (openaiTools.length > 0)
            payload.tools = openaiTools;
    }
    return payload;
}
// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────
function parseDSMLToolCalls(text) {
    try {
        const invokeRegex = /<DSML\|invoke name="([^"]+)">([\s\S]*?)<\/DSML\|invoke>/g;
        const functionCalls = [];
        let invokeMatch;
        while ((invokeMatch = invokeRegex.exec(text)) !== null) {
            const funcName = invokeMatch[1];
            const paramsBlock = invokeMatch[2];
            const args = {};
            const paramRegex = /<DSML\|parameter name="([^"]+)"(?: string="([^"]+)")?>([\s\S]*?)<\/DSML\|parameter>/g;
            let paramMatch;
            while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
                const paramName = paramMatch[1];
                let paramValue = paramMatch[3].trim();
                const isString = paramMatch[2] === 'true';
                if (!isString) {
                    try {
                        paramValue = JSON.parse(paramValue);
                    }
                    catch (e) {
                        electron_log_1.default.debug('[OpenAI] DSML param parse fallback:', e.message); /* keep as string */
                    }
                }
                args[paramName] = paramValue;
            }
            functionCalls.push({ name: funcName, args });
        }
        if (functionCalls.length === 0)
            return null;
        electron_log_1.default.info(`[Proxy] Detected ${functionCalls.length} DSML tool call(s): ${functionCalls.map((f) => f.name).join(', ')}`);
        let cleanText = text;
        cleanText = cleanText.replace(/<DSML\|tool_calls>[\s\S]*?<\/DSML\|tool_calls>/g, '');
        cleanText = cleanText.replace(/<DSML\|invoke name="[^"]+">[\s\S]*?<\/DSML\|invoke>/g, '');
        cleanText = cleanText.trim();
        return { functionCalls, cleanText };
    }
    catch (e) {
        electron_log_1.default.error('[Proxy] Failed to parse DSML tool calls:', e);
        return null;
    }
}
function mapOpenAIToGemini(openAiRes, modelName, toolSchemas) {
    const choice = openAiRes.choices?.[0];
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
        const parts = choice.message.tool_calls.map((tc) => {
            let args;
            try {
                args =
                    typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : tc.function.arguments;
            }
            catch (e) {
                electron_log_1.default.debug('[OpenAI] Tool call args parse fallback:', e.message);
                args = {};
            }
            args = (0, utils_1.normalizeToolArgs)(tc.function.name, args, toolSchemas);
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.function.name] = tc.id;
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const translated = (0, utils_1.translateToolCallToNative)(tc.function.name, args, toolSchemas);
            if (translated.name !== tc.function.name) {
                translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args, toolSchemas);
                shared_1.translatedToolCalls.set(tc.id, {
                    originalName: tc.function.name,
                    translatedName: translated.name,
                    cmd: args.CommandLine || '',
                    cwd: args.Cwd || '',
                });
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, tc.id);
            }
            return { functionCall: { name: translated.name, args: translated.args, id: tc.id } };
        });
        if (choice.message.content)
            parts.unshift({ text: choice.message.content });
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
            usageMetadata: {
                promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
                candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
                totalTokenCount: openAiRes.usage?.total_tokens || 0,
            },
        };
    }
    const text = choice?.message?.content || '';
    const dsml = parseDSMLToolCalls(text);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map((fc) => {
            const na = (0, utils_1.normalizeToolArgs)(fc.name, fc.args, toolSchemas);
            const tr = (0, utils_1.translateToolCallToNative)(fc.name, na, toolSchemas);
            return { functionCall: { name: tr.name, args: tr.args } };
        });
        if (dsml.cleanText)
            parts.unshift({ text: dsml.cleanText });
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
            usageMetadata: {
                promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
                candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
                totalTokenCount: openAiRes.usage?.total_tokens || 0,
            },
        };
    }
    const parts = [];
    if (reasoning)
        parts.push({ text: reasoning, thought: true });
    if (text)
        parts.push({ text });
    const finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
    return {
        candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
        usageMetadata: {
            promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
            candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
            totalTokenCount: openAiRes.usage?.total_tokens || 0,
        },
    };
}
// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────
// Track emitted prose without changing shared stream state. Context cleanup also
// releases the cursor; a possible DSML prefix is held until its meaning is known.
const streamedTextPositions = new WeakMap();
function takeStreamText(context, terminal = false) {
    const start = streamedTextPositions.get(context) || 0;
    let end = context.accumulatedText.length;
    if (!terminal) {
        const marker = '<DSML|';
        const index = context.accumulatedText.indexOf(marker, start);
        if (index >= 0)
            end = index;
        else {
            for (let length = marker.length - 1; length > 0; length--) {
                if (context.accumulatedText.endsWith(marker.slice(0, length))) {
                    end -= length;
                    break;
                }
            }
        }
    }
    streamedTextPositions.set(context, end);
    return context.accumulatedText.slice(start, end);
}
function mapOpenAIChunkToGemini(chunk, modelName, streamKey, toolSchemas) {
    const choice = chunk.choices?.[0];
    if (!choice)
        return null;
    const delta = choice.delta;
    const streamId = streamKey || chunk.id || 'default_stream';
    if (!shared_1.activeStreamContexts.has(streamId)) {
        shared_1.activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.streamCtx, streamId);
    }
    const context = shared_1.activeStreamContexts.get(streamId);
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!context.toolCalls[idx])
                context.toolCalls[idx] = { id: '', name: '', arguments: '' };
            if (tc.id)
                context.toolCalls[idx].id = tc.id;
            if (tc.function?.name)
                context.toolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments)
                context.toolCalls[idx].arguments += tc.function.arguments;
        }
    }
    const finishReason = choice.finish_reason;
    const completed = finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls';
    if (delta?.content)
        context.accumulatedText += delta.content;
    const reasoning = delta?.reasoning_content || delta?.reasoning || '';
    if (reasoning) {
        context.accumulatedReasoning += reasoning;
        if (!completed)
            return {
                content: { parts: [{ text: reasoning, thought: true }], role: 'model' },
                finishReason: 'OTHER',
                index: 0,
            };
    }
    const completionParts = reasoning ? [{ text: reasoning, thought: true }] : [];
    // A complete invoke can precede a fragmented parallel invoke. Keep both until
    // the provider finishes, including providers that finish DSML with tool_calls.
    if (completed && Object.keys(context.toolCalls).length === 0) {
        const remaining = context.accumulatedText.slice(streamedTextPositions.get(context) || 0);
        const dsml = parseDSMLToolCalls(remaining);
        if (dsml && dsml.functionCalls.length > 0) {
            if (dsml.cleanText)
                completionParts.push({ text: dsml.cleanText });
            for (const fc of dsml.functionCalls) {
                const args = (0, utils_1.normalizeToolArgs)(fc.name, fc.args, toolSchemas);
                const translated = (0, utils_1.translateToolCallToNative)(fc.name, args, toolSchemas);
                completionParts.push({
                    functionCall: { name: translated.name, args: translated.args },
                });
            }
            shared_1.activeStreamContexts.delete(streamId);
            return { content: { parts: completionParts, role: 'model' }, finishReason: 'STOP', index: 0 };
        }
    }
    if (completed) {
        const text = takeStreamText(context, true);
        if (text)
            completionParts.push({ text });
    }
    if (finishReason === 'stop' || finishReason === 'length') {
        // Check for pending native tool_calls before closing stream
        const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => tc.name && tc.arguments);
        if (pendingToolCalls.length > 0) {
            const parts = pendingToolCalls.map((tc) => {
                let args = {};
                try {
                    args = JSON.parse(tc.arguments);
                }
                catch (_e) {
                    args = {};
                }
                args = (0, utils_1.normalizeToolArgs)(tc.name, args, toolSchemas);
                const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                modelTCIds[tc.name] = tc.id;
                shared_1.modelToolCallIds.set(modelName, modelTCIds);
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
                const translated = (0, utils_1.translateToolCallToNative)(tc.name, args, toolSchemas);
                if (translated.name !== tc.name) {
                    shared_1.translatedToolCalls.set(tc.id, {
                        originalName: tc.name,
                        translatedName: translated.name,
                        cmd: args.CommandLine || '',
                        cwd: args.Cwd || '',
                    });
                    (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, tc.id);
                }
                return { functionCall: { name: translated.name, args: translated.args, id: tc.id } };
            });
            shared_1.activeStreamContexts.delete(streamId);
            return { content: { parts: [...completionParts, ...parts], role: 'model' }, finishReason: 'STOP', index: 0 };
        }
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts: completionParts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    // Only emit tool calls when finishReason signals completion (args are fully accumulated)
    if (finishReason === 'tool_calls') {
        const parts = Object.values(context.toolCalls).map((tc) => {
            let args = {};
            try {
                args = JSON.parse(tc.arguments);
            }
            catch (e) {
                electron_log_1.default.debug('[OpenAI] Stream tool args parse fallback:', e.message);
                args = {};
            }
            args = (0, utils_1.normalizeToolArgs)(tc.name, args, toolSchemas);
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.name] = tc.id;
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const translated = (0, utils_1.translateToolCallToNative)(tc.name, args, toolSchemas);
            if (translated.name !== tc.name) {
                translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args, toolSchemas);
                shared_1.translatedToolCalls.set(tc.id, {
                    originalName: tc.name,
                    translatedName: translated.name,
                    cmd: args.CommandLine || '',
                    cwd: args.Cwd || '',
                });
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, tc.id);
            }
            return { functionCall: { name: translated.name, args: translated.args, id: tc.id } };
        });
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts: [...completionParts, ...parts], role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    const text = takeStreamText(context);
    if (text) {
        return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    }
    return null;
}
//# sourceMappingURL=openai.js.map