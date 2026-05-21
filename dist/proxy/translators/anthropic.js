"use strict";
/**
 * Anthropic provider translator.
 * Handles Gemini ↔ Anthropic request/response mapping and streaming SSE events.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapGeminiToAnthropic = mapGeminiToAnthropic;
exports.mapAnthropicToGemini = mapAnthropicToGemini;
exports.mapAnthropicChunkToGemini = mapAnthropicChunkToGemini;
exports.mapGeminiToolsToAnthropic = mapGeminiToolsToAnthropic;
const electron_log_1 = __importDefault(require("electron-log"));
const utils_1 = require("./utils");
const shared_1 = require("../shared");
const modelUtils_1 = require("../modelUtils");
// ─── REQUEST: Gemini → Anthropic ──────────────────────────────────────────
function mapGeminiToolsToAnthropic(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools))
        return [];
    const anthropicTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const params = func.parameters
                    ? JSON.parse(JSON.stringify(func.parameters))
                    : { type: 'OBJECT', properties: {} };
                if (params.type && typeof params.type === 'string') {
                    params.type = params.type.toLowerCase();
                }
                if (params.properties) {
                    (0, utils_1.fixParamTypes)(params.properties);
                }
                anthropicTools.push({
                    name: func.name,
                    description: func.description || '',
                    input_schema: params,
                });
            }
        }
    }
    return anthropicTools;
}
function mapGeminiToAnthropic(geminiBody, modelName) {
    const messages = [];
    let system = undefined;
    if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
        system = geminiBody.systemInstruction.parts.map(p => p.text || '').join('');
    }
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            if (item.parts) {
                const hasFunctionCall = item.parts.some(p => p.functionCall);
                const hasFunctionResponse = item.parts.some(p => p.functionResponse);
                if (hasFunctionCall && item.role === 'model') {
                    const contentBlocks = [];
                    for (const p of item.parts) {
                        if (p.text)
                            contentBlocks.push({ type: 'text', text: p.text });
                        if (p.functionCall) {
                            const callId = p.functionCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
                            let originalName = p.functionCall.name;
                            let originalArgs = p.functionCall.args;
                            const translatedInfo = shared_1.translatedToolCalls.get(callId);
                            if (translatedInfo) {
                                originalName = translatedInfo.originalName;
                                originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
                            }
                            contentBlocks.push({
                                type: 'tool_use',
                                id: callId,
                                name: originalName,
                                input: typeof originalArgs === 'string'
                                    ? JSON.parse(originalArgs)
                                    : originalArgs,
                            });
                        }
                    }
                    messages.push({ role: 'assistant', content: contentBlocks });
                }
                else if (hasFunctionResponse) {
                    const contentBlocks = [];
                    for (const p of item.parts) {
                        if (p.functionResponse) {
                            const funcName = p.functionResponse.name || '';
                            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                            const toolCallId = p.functionResponse.id || modelTCIds[funcName] || ('call_' + funcName);
                            const responseData = p.functionResponse.response;
                            let contentStr = '';
                            const translatedInfo = shared_1.translatedToolCalls.get(toolCallId);
                            if (translatedInfo) {
                                contentStr = (0, utils_1.formatTranslatedResponse)(translatedInfo, responseData);
                            }
                            else {
                                contentStr = typeof responseData === 'string'
                                    ? responseData
                                    : JSON.stringify(responseData || {});
                            }
                            contentBlocks.push({
                                type: 'tool_result',
                                tool_use_id: toolCallId,
                                content: contentStr,
                            });
                        }
                    }
                    messages.push({ role: 'user', content: contentBlocks });
                }
                else {
                    const roleStr = item.role === 'model' ? 'assistant' : (item.role || 'user');
                    let content = '';
                    if (item.parts)
                        content = item.parts.map(p => p.text || '').join('');
                    if (roleStr === 'system') {
                        system = (system || '') + '\n' + content;
                    }
                    else {
                        messages.push({ role: roleStr, content });
                    }
                }
            }
        }
    }
    const result = {
        model: modelName,
        messages,
        system,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 16000,
    };
    // Claude thinking models don't support temperature (centralized detection)
    const { isThinkingModel } = (0, modelUtils_1.detectModelCapabilitiesByName)(modelName);
    if (!isThinkingModel) {
        const temp = geminiBody.generationConfig?.temperature;
        if (temp !== undefined && temp !== null)
            result.temperature = temp;
    }
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
        const anthTools = mapGeminiToolsToAnthropic(geminiBody.tools);
        if (anthTools.length > 0)
            result.tools = anthTools;
    }
    return result;
}
// ─── RESPONSE: Anthropic → Gemini ─────────────────────────────────────────
function mapAnthropicToGemini(anthRes, modelName) {
    const contentBlocks = anthRes.content || [];
    const parts = [];
    const functionCalls = [];
    for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
        }
        else if (block.type === 'thinking' && block.thinking) {
            parts.push({ text: block.thinking, thought: true });
        }
        else if (block.type === 'tool_use') {
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[block.name || ''] = block.id || '';
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const normalizedInput = (0, utils_1.normalizeToolArgs)(block.name || '', block.input || {});
            const translated = (0, utils_1.translateToolCallToNative)(block.name || '', normalizedInput);
            if (translated.name !== block.name) {
                shared_1.translatedToolCalls.set(block.id || '', {
                    originalName: block.name || '',
                    translatedName: translated.name,
                    cmd: block.input?.CommandLine || '',
                    cwd: block.input?.Cwd || '',
                });
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, block.id || '');
            }
            functionCalls.push({
                functionCall: { name: translated.name, args: translated.args, id: block.id },
            });
        }
    }
    if (functionCalls.length > 0) {
        return {
            candidates: [{ content: { parts: [...parts, ...functionCalls], role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
            usageMetadata: {
                promptTokenCount: anthRes.usage?.input_tokens || 0,
                candidatesTokenCount: anthRes.usage?.output_tokens || 0,
                totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
            },
        };
    }
    const finishReason = anthRes.stop_reason === 'end_turn' ? 'STOP' :
        anthRes.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'OTHER';
    return {
        candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
        usageMetadata: {
            promptTokenCount: anthRes.usage?.input_tokens || 0,
            candidatesTokenCount: anthRes.usage?.output_tokens || 0,
            totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
        },
    };
}
// ─── STREAM CHUNK: Anthropic SSE → Gemini ─────────────────────────────────
function mapAnthropicChunkToGemini(chunk, modelName) {
    const type = chunk.type;
    const streamId = chunk.message?.id || 'anthropic_stream';
    if (!shared_1.activeStreamContexts.has(streamId)) {
        shared_1.activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.streamCtx, streamId);
    }
    const context = shared_1.activeStreamContexts.get(streamId);
    if (type === 'content_block_start') {
        const block = chunk.content_block;
        const idx = chunk.index ?? 0;
        if (block?.type === 'tool_use') {
            context.toolCalls[idx] = { id: block.id || '', name: block.name || '', arguments: '' };
        }
    }
    if (type === 'content_block_delta') {
        const delta = chunk.delta;
        const idx = chunk.index ?? 0;
        if (delta?.type === 'text_delta') {
            const text = delta.text || '';
            context.accumulatedText += text;
            return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
        }
        else if (delta?.type === 'thinking_delta') {
            const thinkingText = delta.thinking || '';
            context.accumulatedReasoning += thinkingText;
            return { content: { parts: [{ text: thinkingText, thought: true }], role: 'model' }, finishReason: 'OTHER', index: 0 };
        }
        else if (delta?.type === 'input_delta') {
            if (context.toolCalls[idx]) {
                context.toolCalls[idx].arguments += delta.partial_json || '';
            }
        }
    }
    if (type === 'message_delta') {
        const delta = chunk.delta;
        if (delta?.stop_reason === 'tool_use') {
            const parts = Object.values(context.toolCalls).map(tc => {
                let args = {};
                try {
                    args = JSON.parse(tc.arguments);
                }
                catch (e) {
                    electron_log_1.default.debug('[Anthropic] Stream tool args parse fallback:', e.message);
                    args = {};
                }
                args = (0, utils_1.normalizeToolArgs)(tc.name, args);
                const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                modelTCIds[tc.name] = tc.id;
                shared_1.modelToolCallIds.set(modelName, modelTCIds);
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
                const translated = (0, utils_1.translateToolCallToNative)(tc.name, args);
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
            return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
        }
    }
    if (type === 'message_stop') {
        // Check for pending tool calls before finalizing
        const pendingToolCalls = Object.values(context.toolCalls).filter(tc => tc.name && tc.arguments);
        if (pendingToolCalls.length > 0) {
            const parts = pendingToolCalls.map(tc => {
                let args = {};
                try { args = JSON.parse(tc.arguments); } catch (e) { args = {}; }
                args = (0, utils_1.normalizeToolArgs)(tc.name, args);
                const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                modelTCIds[tc.name] = tc.id;
                shared_1.modelToolCallIds.set(modelName, modelTCIds);
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
                const translated = (0, utils_1.translateToolCallToNative)(tc.name, args);
                if (translated.name !== tc.name) {
                    shared_1.translatedToolCalls.set(tc.id, {
                        originalName: tc.name, translatedName: translated.name,
                        cmd: args.CommandLine || '', cwd: args.Cwd || ''
                    });
                    (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, tc.id);
                }
                return { functionCall: { name: translated.name, args: translated.args, id: tc.id } };
            });
            shared_1.activeStreamContexts.delete(streamId);
            return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
        }
        // Emit any remaining accumulated text on stream end
        if (context.accumulatedText) {
            shared_1.activeStreamContexts.delete(streamId);
            return { content: { parts: [{ text: context.accumulatedText }], role: 'model' }, finishReason: 'STOP', index: 0 };
        }
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    return null;
}
//# sourceMappingURL=anthropic.js.map