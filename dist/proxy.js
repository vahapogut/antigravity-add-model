"use strict";

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let server = null;
let proxyPort = 0;

// Cross-turn state tracking — scoped per model to prevent parallel request corruption
const modelToolCallIds = new Map();     // modelName -> { "functionName": "original_tool_call_id" }
const modelReasoningContent = new Map(); // modelName -> preserved reasoning_content from previous turn
const activeStreamContexts = new Map();  // key: chunk.id -> { accumulatedText, accumulatedReasoning, toolCalls }
const translatedToolCalls = new Map();  // toolCallId -> { originalName, translatedName, cmd, cwd }

/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
function translateToolCallToNative(name, args) {
    if (name !== 'run_command' || !args || !args.CommandLine) {
        return { name, args };
    }

    const cmd = args.CommandLine.trim();
    const cwd = args.Cwd || process.cwd();

    // 1. list_dir translation
    // Matches: ls, dir, ls -la, dir /w, ls ., dir . etc.
    const isListDir = /^(ls|dir)(\s+[\w\-\/\.\*]+)*$/i.test(cmd);
    if (isListDir) {
        let dirPath = cwd;
        const tokens = cmd.split(/\s+/).slice(1);
        const pathToken = tokens.find(t => !t.startsWith('-') && !t.startsWith('/'));
        if (pathToken) {
            dirPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
        }
        console.log(`[Proxy] Translating run_command "${cmd}" to list_dir on "${dirPath}"`);
        return {
            name: 'list_dir',
            args: { DirectoryPath: dirPath }
        };
    }

    // 2. view_file translation
    // Matches: cat file.txt, type file.txt, cat "file space.txt", cat ./file.txt etc.
    const catMatch = /^(cat|type)\s+(["']?)(.*?)\2$/i.exec(cmd);
    if (catMatch) {
        const filePath = catMatch[3].trim();
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        console.log(`[Proxy] Translating run_command "${cmd}" to view_file on "${absPath}"`);
        return {
            name: 'view_file',
            args: { AbsolutePath: absPath }
        };
    }

    // 3. grep_search translation
    // Matches: grep -rn "query" path, grep -i "query" file, findstr /s /i "query" path etc.
    if (cmd.toLowerCase().startsWith('grep') || cmd.toLowerCase().startsWith('findstr')) {
        let query = '';
        let searchPath = cwd;

        const regexQuotes = /"([^"]+)"|'([^']+)'/g;
        const quotesFound = [...cmd.matchAll(regexQuotes)];
        if (quotesFound.length > 0) {
            query = quotesFound[0][1] || quotesFound[0][2];
        } else {
            const tokens = cmd.split(/\s+/);
            query = tokens[tokens.length - 1];
        }

        const tokens = cmd.split(/\s+/);
        const pathToken = tokens.find((t, idx) => idx > 0 && !t.startsWith('-') && !t.startsWith('/') && !t.includes('"') && !t.includes("'") && t !== query);
        if (pathToken) {
            searchPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
        }

        if (query) {
            console.log(`[Proxy] Translating run_command "${cmd}" to grep_search (Query: "${query}", Path: "${searchPath}")`);
            return {
                name: 'grep_search',
                args: {
                    Query: query,
                    SearchPath: searchPath,
                    CaseInsensitive: cmd.includes('-i') || cmd.toLowerCase().includes('/i'),
                    IsRegex: false,
                    MatchPerLine: true
                }
            };
        }
    }

    return { name, args };
}

/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
function formatTranslatedResponse(translatedInfo, responseData) {
    const { translatedName, cmd } = translatedInfo;
    console.log(`[Proxy] Formatting native response back to CLI for translated tool "${translatedName}" (Cmd: "${cmd}")`);

    if (translatedName === 'list_dir') {
        if (Array.isArray(responseData)) {
            return responseData.map(item => {
                const typeIndicator = item.isDir ? '<DIR>' : '     ';
                const sizeStr = item.isDir ? '' : ` (${item.sizeBytes || 0} bytes)`;
                return `${typeIndicator}  ${item.name}${sizeStr}`;
            }).join('\n');
        }
        if (responseData && typeof responseData === 'object') {
            const items = responseData.files || responseData.children || [];
            if (Array.isArray(items)) {
                return items.map(item => `${item.isDir ? '<DIR>' : '     '}  ${item.name}`).join('\n');
            }
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }

    if (translatedName === 'view_file') {
        if (responseData && typeof responseData === 'object') {
            return responseData.content || responseData.CodeContent || JSON.stringify(responseData);
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }

    if (translatedName === 'grep_search') {
        if (Array.isArray(responseData)) {
            return responseData.map(match => `${match.Filename}:${match.LineNumber}:${match.LineContent}`).join('\n');
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }

    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
}

/**
 * Generates a unique, hash-based placeholder model ID from a model's display name.
 * Uses djb2 hash algorithm for fast, deterministic IDs that won't change between restarts.
 */
function generateModelPlaceholderId(model) {
    const input = (model.displayName || model.name || 'custom-model').toLowerCase();
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) + input.charCodeAt(i); // hash * 33 + c
        hash = hash & hash; // Force 32-bit integer
    }
    // Map to supported enums MODEL_PLACEHOLDER_M400 through MODEL_PLACEHOLDER_M599
    const placeholderNum = 400 + (Math.abs(hash) % 200);
    return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

/**
 * Gets the path to the custom models configuration file.
 */
function getCustomModelsPath() {
    const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
    return path.join(geminiDir, 'custom_models.json');
}

/**
 * Loads custom models from the configuration file.
 * Creates a default file if it doesn't exist.
 */
function loadCustomModels() {
    const filePath = getCustomModelsPath();
    const cryptoStore = require('./cryptoStore');
    
    if (!fs.existsSync(filePath)) {
        const defaultModels = {
            models: [
                {
                    name: "models/gpt-4o",
                    displayName: "GPT-4o (OpenAI via Proxy)",
                    description: "OpenAI GPT-4o model redirected through proxy",
                    provider: "openai",
                    apiKey: process.env.OPENAI_API_KEY || "YOUR_OPENAI_API_KEY",
                    apiUrl: "https://api.openai.com/v1/chat/completions",
                    externalModelName: "gpt-4o"
                },
                {
                    name: "models/claude-3-5-sonnet",
                    displayName: "Claude 3.5 Sonnet (Anthropic via Proxy)",
                    description: "Anthropic Claude 3.5 Sonnet model redirected through proxy",
                    provider: "anthropic",
                    apiKey: process.env.ANTHROPIC_API_KEY || "YOUR_ANTHROPIC_API_KEY",
                    apiUrl: "https://api.anthropic.com/v1/messages",
                    externalModelName: "claude-3-5-sonnet-latest"
                },
                {
                    name: "models/llama3",
                    displayName: "Llama 3 (Local Ollama)",
                    description: "Local Ollama Llama 3 model run on your machine",
                    provider: "ollama",
                    apiUrl: "http://localhost:11434/v1/chat/completions",
                    externalModelName: "llama3"
                }
            ]
        };
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            
            // Encrypt keys before writing
            defaultModels.models = cryptoStore.encryptModels(defaultModels.models);
            
            fs.writeFileSync(filePath, JSON.stringify(defaultModels, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Proxy] Failed to write default custom_models.json', e);
        }
        return cryptoStore.decryptModels(defaultModels.models);
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        const models = parsed.models || [];
        
        // Auto-migration check: if any model is not encrypted but has apiKey
        const needsMigration = models.some(m => !m.encrypted && m.apiKey && m.apiKey !== 'none' && !m.apiKey.startsWith('enc:') && !m.apiKey.startsWith('fallback:'));
        if (needsMigration) {
            console.log('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
            cryptoStore.backupFile(filePath);
            const encryptedModels = cryptoStore.encryptModels(models);
            try {
                fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), 'utf-8');
                console.log('[Proxy] Successfully migrated custom_models.json to encrypted format.');
                return cryptoStore.decryptModels(encryptedModels);
            } catch (err) {
                console.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
            }
        }
        
        return cryptoStore.decryptModels(models);
    } catch (e) {
        console.error('[Proxy] Failed to parse custom_models.json', e);
        return [];
    }
}

/**
 * Converts a model name/externalModelName to a slug key matching the format used in fetchAvailableModels.
 */
function toSlug(model) {
    return 'custom-' + (model.externalModelName || model.name)
        .replace(/^models\//, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

/**
 * Recursively converts Gemini parameter types (UPPERCASE) to OpenAI format (lowercase).
 */
function fixParamTypes(properties) {
    if (!properties) return;
    for (const key of Object.keys(properties)) {
        if (properties[key].type && typeof properties[key].type === 'string') {
            properties[key].type = properties[key].type.toLowerCase();
        }
        if (properties[key].properties) {
            fixParamTypes(properties[key].properties);
        }
        if (properties[key].items) {
            if (properties[key].items.type && typeof properties[key].items.type === 'string') {
                properties[key].items.type = properties[key].items.type.toLowerCase();
            }
            if (properties[key].items.properties) {
                fixParamTypes(properties[key].items.properties);
            }
        }
    }
}

/**
 * Maps Gemini tools array to OpenAI tools format.
 */
function mapGeminiToolsToOpenAI(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools)) return [];
    const openaiTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const params = func.parameters ? JSON.parse(JSON.stringify(func.parameters)) : { type: "object", properties: {} };
                if (params.type && typeof params.type === 'string') {
                    params.type = params.type.toLowerCase();
                }
                if (params.properties) {
                    fixParamTypes(params.properties);
                }
                openaiTools.push({
                    type: "function",
                    function: {
                        name: func.name,
                        description: func.description || "",
                        parameters: params
                    }
                });
            }
        }
    }
    return openaiTools;
}

/**
 * Maps Gemini request format to OpenAI/Ollama chat format.
 */
function mapGeminiToOpenAI(geminiBody, modelName) {
    const messages = [];

    // Handle systemInstruction (Cloud Code format)
    if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
        const systemText = geminiBody.systemInstruction.parts.map(p => p.text || '').join('');
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // Map contents to messages (handles user, assistant, and functionCall/functionResponse)
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            if (item.parts) {
                // Check for functionCall (model calling a tool)
                const hasFunctionCall = item.parts.some(p => p.functionCall);
                // Check for functionResponse (tool result returned to model)
                const hasFunctionResponse = item.parts.some(p => p.functionResponse);

                if (hasFunctionCall && item.role === 'model') {
                    const toolCalls = [];
                    for (const p of item.parts) {
                        if (p.functionCall) {
                            // Use preserved original ID from API, or generate one
                            const callId = p.functionCall.id || ("call_" + Math.random().toString(36).slice(2, 10));
                            // Map back from translated name if it was a translated tool call
                            let originalName = p.functionCall.name;
                            let originalArgs = p.functionCall.args;
                            const translatedInfo = translatedToolCalls.get(callId);
                            if (translatedInfo) {
                                originalName = translatedInfo.originalName;
                                originalArgs = {
                                    CommandLine: translatedInfo.cmd,
                                    Cwd: translatedInfo.cwd
                                };
                            }
                            toolCalls.push({
                                id: callId,
                                type: "function",
                                function: {
                                    name: originalName,
                                    arguments: typeof originalArgs === 'string'
                                        ? originalArgs
                                        : JSON.stringify(originalArgs || {})
                                }
                            });
                        }
                    }
                    const assistantMsg = { role: 'assistant', content: null, tool_calls: toolCalls };
                    messages.push(assistantMsg);
                } else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        if (p.functionResponse) {
                            // Match tool_call_id: prefer id from functionResponse, fall back to stored mapping
                            const funcName = p.functionResponse.name || '';
                            const modelToolCalls = modelToolCallIds.get(modelName) || {};
                            const toolCallId = p.functionResponse.id || modelToolCalls[funcName] || ('call_' + funcName);
                            
                            const responseData = p.functionResponse.response;
                            let contentStr = '';
                            const translatedInfo = translatedToolCalls.get(toolCallId);
                            if (translatedInfo) {
                                contentStr = formatTranslatedResponse(translatedInfo, responseData);
                            } else {
                                contentStr = typeof responseData === 'string'
                                    ? responseData
                                    : JSON.stringify(responseData || {});
                            }
                            messages.push({
                                role: 'tool',
                                tool_call_id: toolCallId,
                                content: contentStr
                            });
                        }
                    }
                } else {
                    // Regular text message
                    const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
                    let content = '';
                    let reasoning_content = '';
                    
                    if (role === 'assistant') {
                        const regularParts = item.parts.filter(p => !p.thought);
                        const thoughtParts = item.parts.filter(p => p.thought);
                        content = regularParts.map(p => p.text || '').join('');
                        reasoning_content = thoughtParts.map(p => p.text || '').join('');
                    } else {
                        content = item.parts.map(p => p.text || '').join('');
                    }
                    
                    const msg = { role, content };
                    if (reasoning_content) {
                        msg.reasoning_content = reasoning_content;
                    }
                    messages.push(msg);
                }
            }
        }
    }

    // Inject reasoning_content into assistant messages missing it
    // (required by DeepSeek native API which validates this strictly)
    let lastAssistantIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant') lastAssistantIdx = i;
    }
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && !messages[i].reasoning_content) {
            // Only the last assistant gets the preserved reasoning, others get empty
            const preservedReasoning = modelReasoningContent.get(modelName) || '';
            messages[i].reasoning_content = (i === lastAssistantIdx && preservedReasoning) ? preservedReasoning : '';
        }
    }

    const payload = {
        model: modelName,
        messages: messages,
        temperature: geminiBody.generationConfig?.temperature ?? 0.7,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 4000
    };

    // Map tools if present
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
        const openaiTools = mapGeminiToolsToOpenAI(geminiBody.tools);
        if (openaiTools.length > 0) {
            payload.tools = openaiTools;
        }
    }

    return payload;
}

/**
 * Parses DeepSeek DSML tool call format from text content.
 * Handles both wrapped <DSML|tool_calls> blocks and bare <DSML|invoke> calls.
 */
function parseDSMLToolCalls(text) {
    try {
        // Find tool call invocations using exec loop (compatible with all Node versions)
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

                if (isString) {
                    args[paramName] = paramValue;
                } else {
                    try {
                        args[paramName] = JSON.parse(paramValue);
                    } catch (e) {
                        args[paramName] = paramValue;
                    }
                }
            }

            functionCalls.push({
                name: funcName,
                args: args  // Gemini expects args as object, not string
            });
        }

        if (functionCalls.length === 0) return null;

        console.log(`[Proxy] Detected ${functionCalls.length} DSML tool call(s): ${functionCalls.map(f => f.name).join(', ')}`);

        // Remove all DSML blocks from text
        let cleanText = text;
        cleanText = cleanText.replace(/<DSML\|tool_calls>[\s\S]*?<\/DSML\|tool_calls>/g, '');
        cleanText = cleanText.replace(/<DSML\|invoke name="[^"]+">[\s\S]*?<\/DSML\|invoke>/g, '');
        cleanText = cleanText.trim();

        return { functionCalls, cleanText };
    } catch (e) {
        console.error('[Proxy] Failed to parse DSML tool calls:', e);
        return null;
    }
}

/**
 * Maps OpenAI response format to Gemini format.
 */
function mapOpenAIToGemini(openAiRes, modelName) {
    const choice = openAiRes.choices?.[0];

    // Handle native OpenAI tool_calls
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
        const parts = choice.message.tool_calls.map(tc => {
            let args;
            try {
                args = typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments;
            } catch (e) {
                args = {};
            }
            // Store original tool_call_id for later matching with functionResponse
            const modelTCIds = modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.function.name] = tc.id;
            modelToolCallIds.set(modelName, modelTCIds);

            // Translate tool call to native
            const translated = translateToolCallToNative(tc.function.name, args);
            if (translated.name !== tc.function.name) {
                translatedToolCalls.set(tc.id, {
                    originalName: tc.function.name,
                    translatedName: translated.name,
                    cmd: args.CommandLine,
                    cwd: args.Cwd
                });
            }

            return {
                functionCall: {
                    name: translated.name,
                    args: translated.args,
                    id: tc.id  // preserve through Gemini format
                }
            };
        });

        return {
            candidates: [{
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: 'TOOL_CALL',
                index: 0
            }],
            usageMetadata: {
                promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
                candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
                totalTokenCount: openAiRes.usage?.total_tokens || 0
            }
        };
    }

    // Handle text response
    const text = choice?.message?.content || '';
    let finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';

    // Detect DeepSeek DSML tool calls in text content
    const dsml = parseDSMLToolCalls(text);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map(fc => ({
            functionCall: {
                name: fc.name,
                args: fc.args
            }
        }));

        if (dsml.cleanText) {
            parts.unshift({ text: dsml.cleanText });
        }

        return {
            candidates: [{
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: 'TOOL_CALL',
                index: 0
            }],
            usageMetadata: {
                promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
                candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
                totalTokenCount: openAiRes.usage?.total_tokens || 0
            }
        };
    }

    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    const parts = [];
    if (reasoning) {
        parts.push({ text: reasoning, thought: true });
    }
    if (text) {
        parts.push({ text });
    }

    return {
        candidates: [
            {
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: finishReason,
                index: 0
            }
        ],
        usageMetadata: {
            promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
            candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
            totalTokenCount: openAiRes.usage?.total_tokens || 0
        }
    };
}

/**
 * Maps Gemini tools array to Anthropic tools format.
 */
function mapGeminiToolsToAnthropic(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools)) return [];
    const anthropicTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const params = func.parameters ? JSON.parse(JSON.stringify(func.parameters)) : { type: "OBJECT", properties: {} };
                if (params.type && typeof params.type === 'string') {
                    params.type = params.type.toLowerCase();
                }
                if (params.properties) {
                    fixParamTypes(params.properties);
                }
                anthropicTools.push({
                    name: func.name,
                    description: func.description || "",
                    input_schema: params
                });
            }
        }
    }
    return anthropicTools;
}

/**
 * Maps Gemini request format to Anthropic chat format.
 */
function mapGeminiToAnthropic(geminiBody, modelName) {
    const messages = [];
    let system = undefined;

    // Handle systemInstruction (Cloud Code format)
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
                        if (p.text) {
                            contentBlocks.push({ type: 'text', text: p.text });
                        }
                        if (p.functionCall) {
                            const callId = p.functionCall.id || ("call_" + Math.random().toString(36).slice(2, 10));
                            // Map back from translated name if it was a translated tool call
                            let originalName = p.functionCall.name;
                            let originalArgs = p.functionCall.args;
                            const translatedInfo = translatedToolCalls.get(callId);
                            if (translatedInfo) {
                                originalName = translatedInfo.originalName;
                                originalArgs = {
                                    CommandLine: translatedInfo.cmd,
                                    Cwd: translatedInfo.cwd
                                };
                            }
                            contentBlocks.push({
                                type: 'tool_use',
                                id: callId,
                                name: originalName,
                                input: typeof originalArgs === 'string' ? JSON.parse(originalArgs) : originalArgs
                            });
                        }
                    }
                    messages.push({ role: 'assistant', content: contentBlocks });
                } else if (hasFunctionResponse) {
                    const contentBlocks = [];
                    for (const p of item.parts) {
                        if (p.functionResponse) {
                            const funcName = p.functionResponse.name || '';
                            const modelToolCalls = modelToolCallIds.get(modelName) || {};
                            const toolCallId = p.functionResponse.id || modelToolCalls[funcName] || ('call_' + funcName);
                            
                            const responseData = p.functionResponse.response;
                            let contentStr = '';
                            const translatedInfo = translatedToolCalls.get(toolCallId);
                            if (translatedInfo) {
                                contentStr = formatTranslatedResponse(translatedInfo, responseData);
                            } else {
                                contentStr = typeof responseData === 'string'
                                    ? responseData
                                    : JSON.stringify(responseData || {});
                            }
                            contentBlocks.push({
                                type: 'tool_result',
                                tool_use_id: toolCallId,
                                content: contentStr
                            });
                        }
                    }
                    messages.push({ role: 'user', content: contentBlocks });
                } else {
                    const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
                    let content = '';
                    if (item.parts) {
                        content = item.parts.map(p => p.text || '').join('');
                    }

                    if (role === 'system') {
                        system = (system || '') + '\n' + content;
                    } else {
                        messages.push({ role, content });
                    }
                }
            }
        }
    }

    const result = {
        model: modelName,
        messages: messages,
        system: system,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 16000
    };

    // Claude thinking models (opus-4, sonnet-4, etc.) don't support temperature
    // Only add temperature for non-thinking models
    const isThinkingModel = /opus-4|sonnet-4|claude-4/i.test(modelName);
    if (!isThinkingModel) {
        const temp = geminiBody.generationConfig?.temperature;
        if (temp !== undefined && temp !== null) {
            result.temperature = temp;
        }
    }

    // Map tools if present
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
        const anthTools = mapGeminiToolsToAnthropic(geminiBody.tools);
        if (anthTools.length > 0) {
            result.tools = anthTools;
        }
    }

    return result;
}

/**
 * Maps Anthropic response format to Gemini format.
 * Handles text, tool_use, and mixed content blocks.
 */
function mapAnthropicToGemini(anthRes, modelName) {
    const contentBlocks = anthRes.content || [];
    const parts = [];
    const functionCalls = [];

    for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
            parts.push({ text: block.thinking, thought: true });
        } else if (block.type === 'tool_use') {
            // Store tool_call_id for later matching with functionResponse
            const modelTCIds = modelToolCallIds.get(modelName) || {};
            modelTCIds[block.name] = block.id;
            modelToolCallIds.set(modelName, modelTCIds);

            // Translate tool call to native
            const translated = translateToolCallToNative(block.name, block.input || {});
            if (translated.name !== block.name) {
                translatedToolCalls.set(block.id, {
                    originalName: block.name,
                    translatedName: translated.name,
                    cmd: block.input?.CommandLine,
                    cwd: block.input?.Cwd
                });
            }

            functionCalls.push({
                functionCall: {
                    name: translated.name,
                    args: translated.args,
                    id: block.id
                }
            });
        }
    }

    // If we have tool_use blocks, return TOOL_CALL finish reason
    if (functionCalls.length > 0) {
        return {
            candidates: [{
                content: {
                    parts: [...parts, ...functionCalls],
                    role: 'model'
                },
                finishReason: 'TOOL_CALL',
                index: 0
            }],
            usageMetadata: {
                promptTokenCount: anthRes.usage?.input_tokens || 0,
                candidatesTokenCount: anthRes.usage?.output_tokens || 0,
                totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0)
            }
        };
    }

    // Pure text response
    const finishReason = anthRes.stop_reason === 'end_turn' ? 'STOP' : 
                         anthRes.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'OTHER';

    return {
        candidates: [
            {
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: finishReason,
                index: 0
            }
        ],
        usageMetadata: {
            promptTokenCount: anthRes.usage?.input_tokens || 0,
            candidatesTokenCount: anthRes.usage?.output_tokens || 0,
            totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0)
        }
    };
}

/**
 * Maps OpenAI chat completion chunk to Gemini generateContentResponse format.
 */
function mapOpenAIChunkToGemini(chunk, modelName) {
    const choice = chunk.choices?.[0];
    if (!choice) return null;
    
    const delta = choice.delta;
    const streamId = chunk.id || 'default_stream';
    
    if (!activeStreamContexts.has(streamId)) {
        activeStreamContexts.set(streamId, {
            accumulatedText: '',
            accumulatedReasoning: '',
            toolCalls: {}
        });
    }
    const context = activeStreamContexts.get(streamId);
    
    // 1. Tool call streaming integration
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!context.toolCalls[idx]) {
                context.toolCalls[idx] = { id: '', name: '', arguments: '' };
            }
            if (tc.id) context.toolCalls[idx].id = tc.id;
            if (tc.function?.name) context.toolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments) context.toolCalls[idx].arguments += tc.function.arguments;
        }
    }
    
    // 2. Düşünme süreci (Reasoning) canlı görselleştirme
    let text = delta?.content || '';
    const reasoning = delta?.reasoning_content || delta?.reasoning || '';
    
    if (reasoning) {
        context.accumulatedReasoning += reasoning;
        return {
            candidates: [{
                content: {
                    parts: [{ text: reasoning, thought: true }],
                    role: 'model'
                },
                finishReason: 'OTHER',
                index: 0
            }]
        };
    }
    
    if (text) {
        context.accumulatedText += text;
    }
    
    // Tamamlanmış DSML araç çağrılarını algılama
    const dsml = parseDSMLToolCalls(context.accumulatedText);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map(fc => ({
            functionCall: {
                name: fc.name,
                args: fc.args
            }
        }));
        
        context.accumulatedText = ''; // buffer'ı boşalt
        
        return {
            candidates: [{
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: 'TOOL_CALL',
                index: 0
            }]
        };
    }
    
    const finishReason = choice.finish_reason;
    if (finishReason === 'stop' || finishReason === 'length') {
        activeStreamContexts.delete(streamId);
        return {
            candidates: [{
                content: {
                    parts: text ? [{ text }] : [],
                    role: 'model'
                },
                finishReason: 'STOP',
                index: 0
            }]
        };
    }
    
    if (finishReason === 'tool_calls' || (delta?.tool_calls && Object.keys(context.toolCalls).length > 0 && !text)) {
        const parts = Object.values(context.toolCalls).map(tc => {
            let args = {};
            try {
                args = JSON.parse(tc.arguments);
            } catch (e) {
                try {
                    args = eval('(' + tc.arguments + ')');
                } catch (err) {}
            }
            const modelTCIds = modelToolCallIds.get(modelName) || {};
            modelTCIds[tc.name] = tc.id;
            modelToolCallIds.set(modelName, modelTCIds);

            // Translate tool call to native
            const translated = translateToolCallToNative(tc.name, args);
            if (translated.name !== tc.name) {
                translatedToolCalls.set(tc.id, {
                    originalName: tc.name,
                    translatedName: translated.name,
                    cmd: args.CommandLine,
                    cwd: args.Cwd
                });
            }

            return {
                functionCall: {
                    name: translated.name,
                    args: translated.args,
                    id: tc.id
                }
            };
        });
        
        if (finishReason === 'tool_calls') {
            activeStreamContexts.delete(streamId);
        }
        
        return {
            candidates: [{
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: 'TOOL_CALL',
                index: 0
            }]
        };
    }
    
    if (text) {
        return {
            candidates: [{
                content: {
                    parts: [{ text }],
                    role: 'model'
                },
                finishReason: 'OTHER',
                index: 0
            }]
        };
    }
    
    return null;
}

/**
 * Maps Anthropic chunk event to Gemini generateContentResponse format.
 */
function mapAnthropicChunkToGemini(chunk, modelName) {
    const type = chunk.type;
    const streamId = chunk.message?.id || 'anthropic_stream';
    
    if (!activeStreamContexts.has(streamId)) {
        activeStreamContexts.set(streamId, {
            accumulatedText: '',
            accumulatedReasoning: '',
            toolCalls: {}
        });
    }
    const context = activeStreamContexts.get(streamId);
    
    if (type === 'content_block_start') {
        const block = chunk.content_block;
        const idx = chunk.index ?? 0;
        if (block?.type === 'tool_use') {
            context.toolCalls[idx] = {
                id: block.id,
                name: block.name,
                arguments: ''
            };
        }
    }
    
    if (type === 'content_block_delta') {
        const delta = chunk.delta;
        const idx = chunk.index ?? 0;
        if (delta?.type === 'text_delta') {
            const text = delta.text || '';
            context.accumulatedText += text;
            return {
                candidates: [{
                    content: {
                        parts: [{ text }],
                        role: 'model'
                    },
                    finishReason: 'OTHER',
                    index: 0
                }]
            };
        } else if (delta?.type === 'thinking_delta') {
            const thinkingText = delta.thinking || '';
            context.accumulatedReasoning += thinkingText;
            return {
                candidates: [{
                    content: {
                        parts: [{ text: thinkingText, thought: true }],
                        role: 'model'
                    },
                    finishReason: 'OTHER',
                    index: 0
                }]
            };
        } else if (delta?.type === 'input_delta') {
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
                } catch (e) {
                    try {
                        args = eval('(' + tc.arguments + ')');
                    } catch (err) {}
                }
                const modelTCIds = modelToolCallIds.get(modelName) || {};
                modelTCIds[tc.name] = tc.id;
                modelToolCallIds.set(modelName, modelTCIds);

                // Translate tool call to native
                const translated = translateToolCallToNative(tc.name, args);
                if (translated.name !== tc.name) {
                    translatedToolCalls.set(tc.id, {
                        originalName: tc.name,
                        translatedName: translated.name,
                        cmd: args.CommandLine,
                        cwd: args.Cwd
                    });
                }

                return {
                    functionCall: {
                        name: translated.name,
                        args: translated.args,
                        id: tc.id
                    }
                };
            });
            
            activeStreamContexts.delete(streamId);
            return {
                candidates: [{
                    content: {
                        parts: parts,
                        role: 'model'
                    },
                    finishReason: 'TOOL_CALL',
                    index: 0
                }]
            };
        }
    }
    
    if (type === 'message_stop') {
        activeStreamContexts.delete(streamId);
        return {
            candidates: [{
                content: {
                    parts: [],
                    role: 'model'
                },
                finishReason: 'STOP',
                index: 0
            }]
        };
    }
    
    return null;
}

/**
 * Standard HTTP proxy forwarding to Google.
 */
function proxyToGoogle(req, res, reqBody) {
    const isCloudCodeUrl = req.url.includes('v1internal') || req.url.includes('daily-cloudcode');
    const targetUrl = isCloudCodeUrl ? ('https://' + 'daily-cloudcode-pa.googleapis.com') : ('https://' + 'generativelanguage.googleapis.com');
    const parsedUrl = new URL(req.url, targetUrl);

    const headers = { ...req.headers };
    headers['host'] = isCloudCodeUrl ? 'daily-cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';
    delete headers['connection'];
    delete headers['keep-alive'];

    const isGeneration = req.url.includes('generateContent') || req.url.includes('streamGenerateContent');
    const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;

    if (shouldBufferAndModify) {
        delete headers['accept-encoding'];
    }

    const options = {
        method: req.method,
        headers: headers,
    };

    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
        if (shouldBufferAndModify) {
            let responseChunks = [];
            proxyRes.on('data', chunk => responseChunks.push(chunk));
            proxyRes.on('end', () => {
                const fullResBody = Buffer.concat(responseChunks);
                let text;
                const encoding = proxyRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try {
                        const zlib = require('zlib');
                        text = zlib.gunzipSync(fullResBody).toString('utf-8');
                    } catch (e) {
                        console.error('[Proxy] gunzipSync failed:', e);
                        text = fullResBody.toString('utf-8');
                    }
                } else {
                    text = fullResBody.toString('utf-8');
                }

                console.log(`[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length}):`);
                if (text.length > 0) {
                    console.log(text.slice(0, 800));
                }

                const proxyHost = req.headers.host || 'localhost';
                text = text.replace(/https:(\\?\/)(\\?\/)daily-cloudcode-pa\.googleapis\.com/g, (match, p1, p2) => `http:${p1}${p2}${proxyHost}`);
                text = text.replace(/https:(\\?\/)(\\?\/)cloudcode-pa\.googleapis\.com/g, (match, p1, p2) => `http:${p1}${p2}${proxyHost}`);
                text = text.replace(/https:(\\?\/)(\\?\/)generativelanguage\.googleapis\.com/g, (match, p1, p2) => `http:${p1}${p2}${proxyHost}`);

                const modifiedHeaders = { ...proxyRes.headers };
                delete modifiedHeaders['content-encoding'];

                const modifiedBuffer = Buffer.from(text, 'utf-8');
                modifiedHeaders['content-length'] = modifiedBuffer.length;

                res.writeHead(proxyRes.statusCode, modifiedHeaders);
                res.end(modifiedBuffer);
            });
        } else {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy] Google Forwarding Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
    });

    if (reqBody) {
        proxyReq.write(reqBody);
    }
    proxyReq.end();
}

/**
 * Handles custom model completion requests.
 */
function handleCustomModelRequest(res, model, geminiBody, isStream) {
    let payload;
    let headers = {};

    const provider = model.provider === 'custom' ? 'openai' : model.provider;
    if (provider === 'openai' || provider === 'ollama') {
        payload = mapGeminiToOpenAI(geminiBody, model.externalModelName);
        if (provider === 'openai') {
            headers['Authorization'] = `Bearer ${model.apiKey}`;
        }
        headers['Content-Type'] = 'application/json';
    } else if (provider === 'anthropic') {
        payload = mapGeminiToAnthropic(geminiBody, model.externalModelName);
        headers['x-api-key'] = model.apiKey;
        headers['anthropic-version'] = '2025-04-01';
        headers['Content-Type'] = 'application/json';
    } else if (provider === 'google') {
        payload = geminiBody;
        headers['Content-Type'] = 'application/json';
        headers['x-goog-api-key'] = model.apiKey;
    }

    if (isStream) {
        if (provider === 'openai' || provider === 'ollama' || provider === 'anthropic') {
            payload.stream = true;
        }
    }

    let finalUrlStr = model.apiUrl;
    if (provider === 'openai' || model.provider === 'custom' || provider === 'ollama') {
        const urlLower = finalUrlStr.toLowerCase();
        if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
            if (finalUrlStr.endsWith('/v1')) {
                finalUrlStr += '/chat/completions';
            } else if (!finalUrlStr.endsWith('/')) {
                finalUrlStr += '/v1/chat/completions';
            } else {
                finalUrlStr += 'v1/chat/completions';
            }
        }
    }
    const url = new URL(finalUrlStr);
    const client = url.protocol === 'https:' ? https : http;

    const options = {
        method: 'POST',
        headers: headers
    };

    // Faz 4: Kurumsal SSL bypass
    if (model.allowUnauthorized || model.provider === 'custom') {
        options.rejectUnauthorized = false;
    }

    console.log(`[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})`);

    const request = client.request(url, options, (apiRes) => {
        if (isStream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            let buffer = '';
            apiRes.on('data', (chunk) => {
                buffer += chunk.toString('utf-8');
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep last partial line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (trimmed.startsWith('data: ')) {
                        const dataStr = trimmed.substring(6).trim();
                        if (dataStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(dataStr);
                            let mapped = null;
                            if (provider === 'openai' || provider === 'ollama') {
                                mapped = mapOpenAIChunkToGemini(parsed, model.name);
                            } else if (provider === 'anthropic') {
                                mapped = mapAnthropicChunkToGemini(parsed, model.name);
                            }

                            if (mapped) {
                                const cloudCodeResponse = {
                                    response: mapped,
                                    traceId: "",
                                    metadata: {}
                                };
                                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
                            }
                        } catch (err) {
                            // Suppress logs for partial/invalid json streams, but keep track
                        }
                    }
                }
            });

            apiRes.on('end', () => {
                // Parse last line if any
                if (buffer.trim().startsWith('data: ')) {
                    const dataStr = buffer.trim().substring(6).trim();
                    if (dataStr !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(dataStr);
                            let mapped = null;
                            if (provider === 'openai' || provider === 'ollama') {
                                mapped = mapOpenAIChunkToGemini(parsed, model.name);
                            } else if (provider === 'anthropic') {
                                mapped = mapAnthropicChunkToGemini(parsed, model.name);
                            }
                            if (mapped) {
                                const cloudCodeResponse = {
                                    response: mapped,
                                    traceId: "",
                                    metadata: {}
                                };
                                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
                            }
                        } catch (e) {}
                    }
                }

                // Final STOP signal to safely close stream
                const finalResponse = {
                    response: {
                        candidates: [{
                            content: { parts: [], role: 'model' },
                            finishReason: 'STOP',
                            index: 0
                        }]
                    },
                    traceId: "",
                    metadata: {}
                };
                res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
                res.end();
            });

        } else {
            let body = '';
            apiRes.on('data', chunk => body += chunk);
            apiRes.on('end', () => {
                if (apiRes.statusCode >= 400) {
                    console.error(`[Proxy] API error (${apiRes.statusCode}):`, body.slice(0, 500));
                    res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
                    res.end(body);
                    return;
                }

                try {
                    // Diagnostic: save raw API response in app userData
                    try {
                        const fsDiag = require('fs');
                        const diagPath = path.join(app.getPath('userData'), 'api_response_raw.json');
                        fsDiag.writeFileSync(diagPath, body);
                    } catch (e) {}

                    const parsed = JSON.parse(body);

                    const reasoning = parsed.choices?.[0]?.message?.reasoning_content
                        || parsed.choices?.[0]?.message?.reasoning;
                    if (reasoning) {
                        modelReasoningContent.set(model.name, reasoning);
                    }

                    let mapped;
                    const providerForResponse = model.provider === 'custom' ? 'openai' : model.provider;
                    if (providerForResponse === 'openai' || providerForResponse === 'ollama') {
                        mapped = mapOpenAIToGemini(parsed, model.name);
                    } else if (providerForResponse === 'anthropic') {
                        mapped = mapAnthropicToGemini(parsed, model.name);
                    } else if (providerForResponse === 'google') {
                        mapped = parsed;
                    }

                    const cloudCodeResponse = {
                        response: mapped,
                        traceId: "",
                        metadata: {}
                    };

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(cloudCodeResponse));
                } catch (e) {
                    console.error('[Proxy] Failed to map response:', e);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
                }
            });
        }
    });

    request.on('error', (err) => {
        console.error('[Proxy] Custom Model Request Error:', err);
        if (isStream) {
            const errResponse = { response: { candidates: [{ content: { parts: [{ text: 'Network error: ' + err.message }], role: 'model' }, finishReason: 'STOP', index: 0 }] }, traceId: '', metadata: {} };
            res.write('data: ' + JSON.stringify(errResponse) + '\n\n');
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
        }
    });

    request.write(JSON.stringify(payload));
    request.end();
}

/**
 * Intercepts requests and manages routing.
 */
function handleRequest(req, res) {
    req.url = req.url.replace(/^.*\/dummy_path_padding/, '');
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
        const fullBody = Buffer.concat(bodyChunks);
        const bodyStr = fullBody.toString('utf-8');

        console.log(`[Proxy] Request: ${req.method} ${req.url}`);

        // 1. Intercept /v1internal:fetchAvailableModels
        if (req.url.includes('/v1internal:fetchAvailableModels')) {
            console.log('[Proxy] Intercepting fetchAvailableModels request');

            const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const headers = { ...req.headers };
            headers['host'] = 'daily-cloudcode-pa.googleapis.com';
            delete headers['connection'];
            delete headers['keep-alive'];
            delete headers['accept-encoding'];

            const options = {
                method: req.method,
                headers: headers
            };

            const googleReq = https.request(parsedUrl, options, (googleRes) => {
                let googleBody = '';
                googleRes.on('data', chunk => googleBody += chunk);
                googleRes.on('end', () => {
                    try {
                        console.log(`[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`);

                        const googleJson = JSON.parse(googleBody);
                        const customModels = loadCustomModels();

                        console.log(`[Proxy] Loaded custom models count: ${customModels.length}`);

                        const mergeModels = (target) => {
                            if (Array.isArray(target)) {
                                const mapped = customModels.map((m, idx) => {
                                    const nameLower = (m.name || '').toLowerCase();
                                    const extLower = (m.externalModelName || '').toLowerCase();
                                    const displayLower = (m.displayName || '').toLowerCase();
                                    const isThinking = m.provider === 'anthropic' || m.provider === 'openai' ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(nameLower) ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(extLower) ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(displayLower);
                                    
                                    return {
                                        name: "models/" + generateModelPlaceholderId(m),
                                        version: "1.0",
                                        displayName: m.displayName,
                                        description: m.description,
                                        inputTokenLimit: 1048576,
                                        outputTokenLimit: 4096,
                                        supportedGenerationMethods: ["generateContent", "countTokens"],
                                        temperature: isThinking ? undefined : 0.7,
                                        topP: isThinking ? undefined : 0.9,
                                        topK: isThinking ? undefined : 40
                                    };
                                });
                                return [...mapped, ...target];
                            } else if (target && typeof target === 'object') {
                                const result = { ...target };
                                customModels.forEach((m, idx) => {
                                    const slug = toSlug(m);
                                    const nameLower = (m.name || '').toLowerCase();
                                    const extLower = (m.externalModelName || '').toLowerCase();
                                    const displayLower = (m.displayName || '').toLowerCase();
                                    const isThinking = m.provider === 'anthropic' || m.provider === 'openai' ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(nameLower) ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(extLower) ||
                                        /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i.test(displayLower);

                                    result[slug] = {
                                        displayName: m.displayName,
                                        supportsImages: false,
                                        supportsThinking: isThinking,
                                        recommended: true,
                                        maxTokens: 1048576,
                                        maxOutputTokens: 4096,
                                        tokenizerType: "LLAMA_WITH_SPECIAL",
                                        model: generateModelPlaceholderId(m),
                                        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                                        modelProvider: "MODEL_PROVIDER_GOOGLE"
                                    };
                                    m._slug = slug;
                                    console.log(`[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => supportsThinking: ${isThinking}`);
                                });
                                return result;
                            }
                            return target;
                        };

                        let merged = false;
                        if (googleJson.models) {
                            googleJson.models = mergeModels(googleJson.models);
                            merged = true;
                        }
                        if (googleJson.availableModels) {
                            googleJson.availableModels = mergeModels(googleJson.availableModels);
                            merged = true;
                        }
                        if (googleJson.available_models) {
                            googleJson.available_models = mergeModels(googleJson.available_models);
                            merged = true;
                        }

                        if (!merged) {
                            googleJson.models = {};
                            customModels.forEach((m, idx) => {
                                const slug = toSlug(m);
                                googleJson.models[slug] = {
                                    displayName: m.displayName,
                                    recommended: true,
                                    maxTokens: 1048576,
                                    maxOutputTokens: 4096,
                                    tokenizerType: "LLAMA_WITH_SPECIAL",
                                    model: generateModelPlaceholderId(m),
                                    apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                                    modelProvider: "MODEL_PROVIDER_GOOGLE"
                                };
                                m._slug = slug;
                            });
                        }

                        // Inject custom model slugs into agentModelSorts so UI shows them
                        const customSlugs = customModels.map(m => m._slug).filter(Boolean);
                        if (customSlugs.length > 0) {
                            if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                                googleJson.agentModelSorts.forEach(sort => {
                                    if (sort.groups && Array.isArray(sort.groups)) {
                                        sort.groups.forEach(group => {
                                            if (group.modelIds && Array.isArray(group.modelIds)) {
                                                customSlugs.forEach(slug => {
                                                    if (!group.modelIds.includes(slug)) {
                                                        group.modelIds.push(slug);
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            }
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(googleJson));
                    } catch (err) {
                        console.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
                        const customModels = loadCustomModels();
                        const mappedCustom = {};
                        customModels.forEach((m, idx) => {
                            const slug = toSlug(m);
                            mappedCustom[slug] = {
                                displayName: m.displayName,
                                maxTokens: 1048576,
                                maxOutputTokens: 4096,
                                model: generateModelPlaceholderId(m),
                                apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                                modelProvider: "MODEL_PROVIDER_GOOGLE"
                            };
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ models: mappedCustom }));
                    }
                });
            });

            googleReq.on('error', (err) => {
                console.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
                const customModels = loadCustomModels();
                const mappedCustom = {};
                customModels.forEach((m, idx) => {
                    const slug = toSlug(m);
                    mappedCustom[slug] = {
                        displayName: m.displayName,
                        maxTokens: 1048576,
                        maxOutputTokens: 4096,
                        model: generateModelPlaceholderId(m),
                        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                        modelProvider: "MODEL_PROVIDER_GOOGLE"
                    };
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ models: mappedCustom }));
            });

            if (fullBody && fullBody.length > 0) {
                googleReq.write(fullBody);
            }
            googleReq.end();
            return;
        }

        // 2. Intercept /v1beta/models or /v1/models list request
        if (req.method === 'GET' && (req.url.endsWith('/models') || req.url.includes('/models?'))) {
            console.log('[Proxy] Intercepting models list request');

            const targetUrl = 'https://generativelanguage.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const headers = { ...req.headers };
            headers['host'] = 'generativelanguage.googleapis.com';
            delete headers['connection'];
            delete headers['accept-encoding'];

            const options = { method: 'GET', headers };

            const googleReq = https.request(parsedUrl, options, (googleRes) => {
                let googleBody = '';
                googleRes.on('data', chunk => googleBody += chunk);
                googleRes.on('end', () => {
                    try {
                        const googleJson = JSON.parse(googleBody);
                        const customModels = loadCustomModels();

                        const mappedCustom = customModels.map((m, idx) => ({
                            name: "models/" + generateModelPlaceholderId(m),
                            version: "1.0",
                            displayName: m.displayName,
                            description: m.description,
                            inputTokenLimit: 1048576,
                            outputTokenLimit: 4096,
                            supportedGenerationMethods: ["generateContent", "countTokens"],
                            temperature: 0.7,
                            topP: 0.9,
                            topK: 40
                        }));

                        if (googleJson.models) {
                            googleJson.models = [...mappedCustom, ...googleJson.models];
                        } else {
                            googleJson.models = mappedCustom;
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(googleJson));
                    } catch (err) {
                        console.error('[Proxy] Google list models failed, returning custom models list only:', err);
                        const customModels = loadCustomModels();
                        const mappedCustom = customModels.map((m, idx) => ({
                            name: "models/" + generateModelPlaceholderId(m),
                            version: "1.0",
                            displayName: m.displayName,
                            description: m.description,
                            inputTokenLimit: 1048576,
                            outputTokenLimit: 4096,
                            supportedGenerationMethods: ["generateContent", "countTokens"]
                        }));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ models: mappedCustom }));
                    }
                });
            });

            googleReq.on('error', (err) => {
                console.error('[Proxy] Google models list request error:', err);
                const customModels = loadCustomModels();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    models: customModels.map(m => ({
                        name: m.name,
                        displayName: m.displayName,
                        description: m.description,
                        supportedGenerationMethods: ["generateContent"]
                    }))
                }));
            });
            googleReq.end();
            return;
        }

        // 3. Intercept Cloud Code generation stream or non-stream requests
        const isCloudCodeStream = req.url.includes('/v1internal:streamGenerateContent') || req.url.includes('/v1internal:generateContent');
        if (req.method === 'POST' && isCloudCodeStream) {
            try {
                const reqJson = JSON.parse(bodyStr);
                const modelName = reqJson.model;
                const modelId = reqJson.modelId || reqJson.model_id;
                console.log(`[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`);
                if (modelName) {
                    const customModels = loadCustomModels();
                    const matchedCustomModel = customModels.find((m, idx) => {
                        const enumName = generateModelPlaceholderId(m);
                        return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === modelId;
                    });
                    if (matchedCustomModel) {
                        console.log(`[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`);
                        const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
                        // Cloud Code wraps the actual Gemini request in a "request" field
                        const actualGeminiBody = reqJson.request || reqJson;
                        handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream);
                        return;
                    }
                }
            } catch (err) {
                console.error('[Proxy] Failed to parse Cloud Code stream body:', err);
            }
        }

        // 4. Intercept standard generateContent / streamGenerateContent request
        const generateMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
        const streamMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

        const isGenerate = !!generateMatch;
        const isStandardStream = !!streamMatch;

        if (req.method === 'POST' && (isGenerate || isStandardStream)) {
            const matchedModelName = isGenerate ? generateMatch[1] : streamMatch[1];
            const customModels = loadCustomModels();
            const matchedCustomModel = customModels.find((m, idx) => {
                const enumName = generateModelPlaceholderId(m);
                return m.name === matchedModelName || toSlug(m) === matchedModelName || enumName === matchedModelName || ("models/" + enumName) === matchedModelName;
            });

            if (matchedCustomModel) {
                try {
                    const geminiBody = JSON.parse(bodyStr);
                    handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream);
                    return;
                } catch (e) {
                    console.error('[Proxy] JSON parse error in request body:', e);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
                    return;
                }
            }
        }

        // 5. Fallback: transparent proxy to Google
        proxyToGoogle(req, res, fullBody);
    });
}

/**
 * Starts the local proxy server.
 */
function startProxy() {
    return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        
        let primaryPort = 50999;
        
        function tryListen(port) {
            server.listen(port, '127.0.0.1', () => {
                proxyPort = server.address().port;
                console.log(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
                resolve(proxyPort);
            });
        }

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && primaryPort === 50999) {
                console.warn('[Proxy] Port 50999 is already in use. Retrying on dynamic port...');
                primaryPort = 0; // fallback to any available port
                tryListen(0);
            } else {
                console.error('[Proxy] Startup failed:', err);
                reject(err);
            }
        });
        
        tryListen(primaryPort);
    });
}

/**
 * Stops the local proxy server.
 */
function stopProxy() {
    return new Promise((resolve) => {
        if (server) {
            server.close(() => {
                console.log('[Proxy] Server stopped');
                server = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    startProxy,
    stopProxy,
    getProxyPort: () => proxyPort
};
