"use strict";
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
const path = __importStar(require("path"));
const electron_log_1 = __importDefault(require("electron-log"));
const utils_1 = require("./utils");
const shared_1 = require("../shared");
// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────
function mapGeminiToolsToOpenAI(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools))
        return [];
    const openaiTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const params = func.parameters
                    ? JSON.parse(JSON.stringify(func.parameters))
                    : { type: 'object', properties: {} };
                if (params.type && typeof params.type === 'string') {
                    params.type = params.type.toLowerCase();
                }
                if (params.properties) {
                    (0, utils_1.fixParamTypes)(params.properties);
                }
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
function mapGeminiToOpenAI(geminiBody, modelName) {
    const messages = [];
    if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
        const systemText = geminiBody.systemInstruction.parts.map((p) => p.text || '').join('');
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            if (item.parts) {
                const hasFunctionCall = item.parts.some((p) => p.functionCall);
                const hasFunctionResponse = item.parts.some((p) => p.functionResponse);
                if (hasFunctionCall && item.role === 'model') {
                    const toolCalls = [];
                    for (const p of item.parts) {
                        if (p.functionCall) {
                            const callId = p.functionCall.id || 'call_' + Math.random().toString(36).slice(2, 10);
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
                    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
                }
                else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        if (p.functionResponse) {
                            const funcName = p.functionResponse.name || '';
                            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                            const toolCallId = p.functionResponse.id || modelTCIds[funcName] || 'call_' + funcName;
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
                    let content = '';
                    let reasoning_content = '';
                    if (role === 'assistant') {
                        const regularParts = (item.parts || []).filter((p) => !p.thought);
                        const thoughtParts = (item.parts || []).filter((p) => p.thought);
                        content = regularParts.map((p) => p.text || '').join('');
                        reasoning_content = thoughtParts.map((p) => p.text || '').join('');
                    }
                    else {
                        const parts = item.parts || [];
                        const partsContent = [];
                        for (const p of parts) {
                            if (p.text) {
                                partsContent.push(p.text);
                            }
                            else if (p.fileData) {
                                const fd = p.fileData;
                                // Try to read local files directly
                                try {
                                    const url = new URL(fd.fileUri);
                                    if (url.protocol === 'file:') {
                                        const fs = require('fs');
                                        const fileContent = fs.readFileSync(url.pathname.replace(/^\//, '').replace(/\//g, path.sep), 'utf-8');
                                        partsContent.push(`[File content from ${fd.fileUri}]:\n${fileContent}`);
                                    }
                                    else {
                                        partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                                    }
                                }
                                catch {
                                    partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                                }
                            }
                            else if (p.inlineData) {
                                const id = p.inlineData;
                                if (id.mimeType && id.mimeType.startsWith('image/')) {
                                    partsContent.push(`[Image: data:${id.mimeType};base64,${id.data}]`);
                                }
                                else {
                                    partsContent.push(`[Inline data: ${id.mimeType}, length: ${(id.data || '').length} chars]`);
                                }
                            }
                        }
                        content = partsContent.join('\n');
                    }
                    const msg = { role, content };
                    if (reasoning_content)
                        msg.reasoning_content = reasoning_content;
                    messages.push(msg);
                }
            }
        }
    }
    // Inject reasoning_content into assistant messages missing it
    let lastAssistantIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant')
            lastAssistantIdx = i;
    }
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && !messages[i].reasoning_content) {
            const preservedReasoning = shared_1.modelReasoningContent.get(modelName) || '';
            messages[i].reasoning_content = i === lastAssistantIdx && preservedReasoning ? preservedReasoning : '';
        }
    }
    // OpenAI reasoning/o-series and gpt-4.1 models require max_completion_tokens
    // and don't support temperature
    const isReasoningModel = /(^|\/)(o1|o3|o4)(-|$)/i.test(modelName);
    const is41Model = /(^|\/)(gpt-4\.1)/i.test(modelName);
    const needsCompletionTokens = isReasoningModel || is41Model;
    const needsNoTemperature = isReasoningModel;
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
function mapOpenAIToGemini(openAiRes, modelName) {
    const choice = openAiRes.choices?.[0];
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
            args = (0, utils_1.normalizeToolArgs)(tc.function.name, args);
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.function.name] = tc.id;
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const translated = (0, utils_1.translateToolCallToNative)(tc.function.name, args);
            if (translated.name !== tc.function.name) {
                translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args);
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
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
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
            const na = (0, utils_1.normalizeToolArgs)(fc.name, fc.args);
            const tr = (0, utils_1.translateToolCallToNative)(fc.name, na);
            return { functionCall: { name: tr.name, args: tr.args } };
        });
        if (dsml.cleanText)
            parts.unshift({ text: dsml.cleanText });
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
            usageMetadata: {
                promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
                candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
                totalTokenCount: openAiRes.usage?.total_tokens || 0,
            },
        };
    }
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
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
function mapOpenAIChunkToGemini(chunk, modelName) {
    const choice = chunk.choices?.[0];
    if (!choice)
        return null;
    const delta = choice.delta;
    const streamId = chunk.id || 'default_stream';
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
    let text = delta?.content || '';
    const reasoning = delta?.reasoning_content || delta?.reasoning || '';
    if (reasoning) {
        context.accumulatedReasoning += reasoning;
        return { content: { parts: [{ text: reasoning, thought: true }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    }
    if (text)
        context.accumulatedText += text;
    const dsml = parseDSMLToolCalls(context.accumulatedText);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map((fc) => {
            const na = (0, utils_1.normalizeToolArgs)(fc.name, fc.args);
            const tr = (0, utils_1.translateToolCallToNative)(fc.name, na);
            return { functionCall: { name: tr.name, args: tr.args } };
        });
        context.accumulatedText = '';
        return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
    }
    const finishReason = choice.finish_reason;
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
        // Check for accumulated DSML tool calls
        if (context.accumulatedText) {
            const dsml2 = parseDSMLToolCalls(context.accumulatedText);
            if (dsml2 && dsml2.functionCalls.length > 0) {
                const parts = dsml2.functionCalls.map((fc) => {
                    const na = (0, utils_1.normalizeToolArgs)(fc.name, fc.args);
                    const tr = (0, utils_1.translateToolCallToNative)(fc.name, na);
                    return { functionCall: { name: tr.name, args: tr.args } };
                });
                if (dsml2.cleanText)
                    parts.unshift({ text: dsml2.cleanText });
                shared_1.activeStreamContexts.delete(streamId);
                return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
            }
        }
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts: text ? [{ text }] : [], role: 'model' }, finishReason: 'STOP', index: 0 };
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
            args = (0, utils_1.normalizeToolArgs)(tc.name, args);
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.name] = tc.id;
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const translated = (0, utils_1.translateToolCallToNative)(tc.name, args);
            if (translated.name !== tc.name) {
                translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args);
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
    if (text) {
        return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    }
    return null;
}
//# sourceMappingURL=openai.js.map