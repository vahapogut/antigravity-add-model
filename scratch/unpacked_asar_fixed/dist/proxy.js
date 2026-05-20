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
 * Maps Gemini request format to OpenAI/Ollama chat format.
 */
function mapGeminiToOpenAI(geminiBody, modelName) {
    const messages = [];
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
            let content = '';
            if (item.parts) {
                content = item.parts.map(p => p.text || '').join('');
            }
            messages.push({ role, content });
        }
    }
    
    return {
        model: modelName,
        messages: messages,
        temperature: geminiBody.generationConfig?.temperature ?? 0.7,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 4000
    };
}

/**
 * Maps OpenAI response format to Gemini format.
 */
function mapOpenAIToGemini(openAiRes, modelName) {
    const text = openAiRes.choices?.[0]?.message?.content || '';
    const finishReason = openAiRes.choices?.[0]?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
    
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
    
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
            let content = '';
            if (item.parts) {
                content = item.parts.map(p => p.text || '').join('');
            }
            
            if (role === 'system') {
                system = content;
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
    const targetUrl = 'https://generativelanguage.googleapis.com';
    const parsedUrl = new URL(req.url, targetUrl);
    
    const headers = { ...req.headers };
    headers['host'] = 'generativelanguage.googleapis.com';
    delete headers['connection'];
    delete headers['keep-alive'];
    
    const options = {
        method: req.method,
        headers: headers,
    };
    
    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
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
 * Handles custom model completion requests (non-streaming).
 */
function handleCustomModelRequest(res, model, geminiBody) {
    let payload;
    let headers = {};
    
    if (model.provider === 'openai' || model.provider === 'ollama') {
        payload = mapGeminiToOpenAI(geminiBody, model.externalModelName);
        if (model.provider === 'openai') {
            headers['Authorization'] = `Bearer ${model.apiKey}`;
        }
        headers['Content-Type'] = 'application/json';
    } else if (model.provider === 'anthropic') {
        payload = mapGeminiToAnthropic(geminiBody, model.externalModelName);
        headers['x-api-key'] = model.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['Content-Type'] = 'application/json';
    } else if (model.provider === 'google') {
        payload = geminiBody;
        headers['Content-Type'] = 'application/json';
        headers['x-goog-api-key'] = model.apiKey;
    }
    
    const url = new URL(model.apiUrl);
    const client = url.protocol === 'https:' ? https : http;
    
    const options = {
        method: 'POST',
        headers: headers
    };
    
    console.log(`[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl})`);
    
    const req = client.request(url, options, (apiRes) => {
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
                const parsed = JSON.parse(body);
                let mapped;
                if (model.provider === 'openai' || model.provider === 'ollama') {
                    mapped = mapOpenAIToGemini(parsed, model.name);
                } else if (model.provider === 'anthropic') {
                    mapped = mapAnthropicToGemini(parsed, model.name);
                } else if (model.provider === 'google') {
                    mapped = parsed;
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(mapped));
            } catch (e) {
                console.error('[Proxy] Failed to map response:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
            }
        });
    });
    
    req.on('error', (err) => {
        console.error('[Proxy] Custom Model Request Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
    });
    
    req.write(JSON.stringify(payload));
    req.end();
}

/**
 * Intercepts requests and manages routing.
 */
function handleRequest(req, res) {
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
        const fullBody = Buffer.concat(bodyChunks);
        const bodyStr = fullBody.toString('utf-8');
        
        console.log(`[Proxy] Request: ${req.method} ${req.url}`);
        
        // 1. Intercept /v1beta/models or /v1/models list request
        if (req.method === 'GET' && (req.url.endsWith('/models') || req.url.includes('/models?'))) {
            console.log('[Proxy] Intercepting models list request');
            
            // First, fetch the real models from Google
            const targetUrl = 'https://generativelanguage.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const headers = { ...req.headers };
            headers['host'] = 'generativelanguage.googleapis.com';
            delete headers['connection'];
            
            const options = { method: 'GET', headers };
            
            const googleReq = https.request(parsedUrl, options, (googleRes) => {
                let googleBody = '';
                googleRes.on('data', chunk => googleBody += chunk);
                googleRes.on('end', () => {
                    try {
                        const googleJson = JSON.parse(googleBody);
                        const customModels = loadCustomModels();
                        
                        // Map custom models to Gemini format
                        const mappedCustom = customModels.map(m => ({
                            name: m.name,
                            version: "1.0",
                            displayName: m.displayName,
                            description: m.description,
                            inputTokenLimit: 128000,
                            outputTokenLimit: 4096,
                            supportedGenerationMethods: ["generateContent", "countTokens"],
                            temperature: 0.7,
                            topP: 0.9,
                            topK: 40
                        }));
                        
                        // Merge the models list
                        if (googleJson.models) {
                            googleJson.models = [...mappedCustom, ...googleJson.models];
                        } else {
                            googleJson.models = mappedCustom;
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(googleJson));
                    } catch (err) {
                        // If Google fetch fails, return custom models list only so the app still works!
                        console.error('[Proxy] Google list models failed, returning custom models list only:', err);
                        const customModels = loadCustomModels();
                        const mappedCustom = customModels.map(m => ({
                            name: m.name,
                            version: "1.0",
                            displayName: m.displayName,
                            description: m.description,
                            inputTokenLimit: 128000,
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
        
        // 2. Intercept generateContent request
        const generateMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
        const streamMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);
        
        const isGenerate = !!generateMatch;
        const isStream = !!streamMatch;
        
        if (req.method === 'POST' && (isGenerate || isStream)) {
            const matchedModelName = isGenerate ? generateMatch[1] : streamMatch[1];
            const customModels = loadCustomModels();
            const matchedCustomModel = customModels.find(m => m.name === matchedModelName);
            
            if (matchedCustomModel) {
                try {
                    const geminiBody = JSON.parse(bodyStr);
                    // Standard generateContent or streamGenerateContent
                    // Note: for simplicity and absolute stability, we redirect stream requests to non-stream,
                    // returning the full response in a single mock-stream chunk. The UI handles single-chunk streams perfectly.
                    handleCustomModelRequest(res, matchedCustomModel, geminiBody);
                    return;
                } catch (e) {
                    console.error('[Proxy] JSON parse error in request body:', e);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
                    return;
                }
            }
        }
        
        // 3. Fallback: transparent proxy to Google
        proxyToGoogle(req, res, fullBody);
    });
}

/**
 * Starts the local proxy server.
 */
function startProxy() {
    return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        server.listen(0, '127.0.0.1', () => {
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
