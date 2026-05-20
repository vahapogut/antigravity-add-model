"use strict";

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let server = null;
let proxyPort = 0;

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
            fs.writeFileSync(filePath, JSON.stringify(defaultModels, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Proxy] Failed to write default custom_models.json', e);
        }
        return defaultModels.models;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        return parsed.models || [];
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
                            toolCalls.push({
                                id: "call_" + Math.random().toString(36).slice(2, 10),
                                type: "function",
                                function: {
                                    name: p.functionCall.name,
                                    arguments: typeof p.functionCall.args === 'string'
                                        ? p.functionCall.args
                                        : JSON.stringify(p.functionCall.args || {})
                                }
                            });
                        }
                    }
                    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
                } else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        if (p.functionResponse) {
                            messages.push({
                                role: 'tool',
                                tool_call_id: p.functionResponse.id || "call_unknown",
                                content: typeof p.functionResponse.response === 'string'
                                    ? p.functionResponse.response
                                    : JSON.stringify(p.functionResponse.response || {})
                            });
                        }
                    }
                } else {
                    // Regular text message
                    const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
                    let content = '';
                    content = item.parts.map(p => p.text || '').join('');
                    messages.push({ role, content });
                }
            }
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
            return {
                functionCall: {
                    name: tc.function.name,
                    args: args  // Gemini expects object, OpenAI sends string
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

    return {
        candidates: [
            {
                content: {
                    parts: [{ text }],
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

    return {
        model: modelName,
        messages: messages,
        system: system,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 4000,
        temperature: geminiBody.generationConfig?.temperature ?? 0.7
    };
}

/**
 * Maps Anthropic response format to Gemini format.
 */
function mapAnthropicToGemini(anthRes, modelName) {
    const text = anthRes.content?.[0]?.text || '';
    const finishReason = anthRes.stop_reason === 'end_turn' ? 'STOP' : 'OTHER';

    return {
        candidates: [
            {
                content: {
                    parts: [{ text }],
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
        headers['anthropic-version'] = '2023-06-01';
        headers['Content-Type'] = 'application/json';
    } else if (provider === 'google') {
        payload = geminiBody;
        headers['Content-Type'] = 'application/json';
        headers['x-goog-api-key'] = model.apiKey;
    }

    let finalUrlStr = model.apiUrl;
    if ((provider === 'openai' || model.provider === 'custom') && finalUrlStr.endsWith('/v1')) {
        finalUrlStr += '/chat/completions';
    }
    const url = new URL(finalUrlStr);
    const client = url.protocol === 'https:' ? https : http;

    const options = {
        method: 'POST',
        headers: headers
    };

    console.log(`[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})`);

    const request = client.request(url, options, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            if (apiRes.statusCode >= 400) {
                console.error(`[Proxy] API error (${apiRes.statusCode}):`, body);
                res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
                res.end(body);
                return;
            }

            try {
                // Diagnostic: save raw API response
                try {
                    const fsDiag = require('fs');
                    fsDiag.writeFileSync('c:\\Users\\vahap\\OneDrive\\Desktop\\antigravity-add-model\\scratch\\api_response_raw.json', body);
                } catch (e) {}

                const parsed = JSON.parse(body);
                let mapped;
                const providerForResponse = model.provider === 'custom' ? 'openai' : model.provider;
                if (providerForResponse === 'openai' || providerForResponse === 'ollama') {
                    mapped = mapOpenAIToGemini(parsed, model.name);
                } else if (providerForResponse === 'anthropic') {
                    mapped = mapAnthropicToGemini(parsed, model.name);
                } else if (providerForResponse === 'google') {
                    mapped = parsed;
                }

                // Wrap in Cloud Code envelope format (matches Google's internal API)
                const cloudCodeResponse = {
                    response: mapped,
                    traceId: "",
                    metadata: {}
                };

                if (isStream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
                    res.end();
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(cloudCodeResponse));
                }
            } catch (e) {
                console.error('[Proxy] Failed to map response:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
            }
        });
    });

    request.on('error', (err) => {
        console.error('[Proxy] Custom Model Request Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
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
                                const mapped = customModels.map((m, idx) => ({
                                    name: "models/MODEL_PLACEHOLDER_M" + (400 + idx),
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
                                return [...mapped, ...target];
                            } else if (target && typeof target === 'object') {
                                const result = { ...target };
                                customModels.forEach((m, idx) => {
                                    const slug = toSlug(m);
                                    result[slug] = {
                                        displayName: m.displayName,
                                        supportsImages: false,
                                        supportsThinking: false,
                                        recommended: true,
                                        maxTokens: 1048576,
                                        maxOutputTokens: 4096,
                                        tokenizerType: "LLAMA_WITH_SPECIAL",
                                        model: "MODEL_PLACEHOLDER_M" + (400 + idx),
                                        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                                        modelProvider: "MODEL_PROVIDER_GOOGLE"
                                    };
                                    m._slug = slug;
                                    console.log(`[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: MODEL_PLACEHOLDER_M${400 + idx}`);
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
                                    model: "MODEL_PLACEHOLDER_M" + (400 + idx),
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
                                model: "MODEL_PLACEHOLDER_M" + (400 + idx),
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
                        model: "MODEL_PLACEHOLDER_M" + (400 + idx),
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
                            name: "models/MODEL_PLACEHOLDER_M" + (400 + idx),
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
                            name: "models/MODEL_PLACEHOLDER_M" + (400 + idx),
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
                        const enumName = "MODEL_PLACEHOLDER_M" + (400 + idx);
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
                const enumName = "MODEL_PLACEHOLDER_M" + (400 + idx);
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
        server.listen(50999, '127.0.0.1', () => {
            proxyPort = server.address().port;
            console.log(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
            resolve(proxyPort);
        });

        server.on('error', (err) => {
            console.error('[Proxy] Startup failed:', err);
            reject(err);
        });
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
