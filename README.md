# Antigravity Custom Model Enabler

This repository contains a patch for **Google Antigravity** that enables external AI models (OpenAI, Anthropic, Together API, Ollama, Google AI Studio, and any OpenAI-compatible provider) alongside the built-in Gemini models. It injects a local HTTP proxy into the Electron app, reverse-engineers the Cloud Code internal API (`v1internal`), translates request/response formats between providers, and provides an inline "Add Model" UI in the Settings page.

## How It Works

### Architecture

```
Antigravity IDE
  └── Language Server (Go binary)
        └── --api_server_url → http://127.0.0.1:50999 (local proxy)
                                  ├── Google models → daily-cloudcode-pa.googleapis.com
                                  └── Custom models → external API (Together, OpenAI, etc.)
```

### Key Components

| `dist/proxy.js` | Local HTTP proxy: intercepts Cloud Code API, merges custom models, translates formats, wraps responses |
| `dist/languageServer.js` | Starts proxy on app launch, points language server to local proxy |
| `dist/ipcHandlers.js` | Backend IPC: `storage:get-custom-models`, `storage:save-custom-model`, `storage:delete-custom-model` |
| `dist/cryptoStore.js` | AES-256-GCM API key encryption via Electron `safeStorage` |
| `dist/schemaValidator.js` | Runtime schema validation for API responses, custom models, and streaming chunks |
| `dist/preload.js` | UI injection: "Custom Models" dashboard in Settings → Models tab, inline Add Model modal with animations |
| `dist/main.js` | App lifecycle: intercepts & blocks `SetCloudCodeURL` requests to prevent frontend from overriding proxy endpoint |
| `repack.ps1` | PowerShell script: stop Antigravity, repack `app.asar`, restart (fully portable via `$env:LOCALAPPDATA`)

### Cloud Code API Reverse Engineering

Antigravity uses Google's **Cloud Code internal API** (`v1internal:*` endpoints) instead of the public Gemini API. The proxy handles these differences:

1. **fetchAvailableModels**: Intercepts and injects custom model definitions. Custom model slugs are added to `agentModelSorts` so they appear in the chat model dropdown. Quota info is omitted for custom models since they use the user's own API key.

2. **streamGenerateContent/generateContent**: Cloud Code wraps the Gemini request inside a `request` field:
   ```json
   {
     "project": "...",
     "requestId": "...",
     "request": { "contents": [...], "systemInstruction": {...}, "generationConfig": {...} },
     "model": "custom-deepseek-ai-deepseek-v4-pro"
   }
   ```
   The proxy extracts `request` before format translation.

3. **systemInstruction**: Cloud Code sends model identity/tool definitions in a separate `systemInstruction` field (not inside `contents`). The proxy maps this to OpenAI's `role: "system"` or Anthropic's `system` parameter.

4. **Response envelope**: Cloud Code wraps responses in `{"response": {...}, "traceId": "...", "metadata": {}}`. The proxy mirrors this format so the IDE accepts the response.

### Request/Response Flow

```
1. User selects custom model and sends message
2. IDE → POST /v1internal:streamGenerateContent?alt=sse → local proxy
3. Proxy detects custom model match (by slug or hash-based MODEL_PLACEHOLDER_* ID)
4. Extracts reqJson.request → maps systemInstruction + contents to provider format
5. POST to external API (e.g. https://api.together.xyz/v1/chat/completions)
6. Maps external response back to Gemini format
7. Wraps in Cloud Code envelope {"response": {...}, "traceId": "", "metadata": {}}
8. Returns SSE: data: {envelope}\n\n → IDE displays response
```

### Streaming Fix (Critical)

The proxy differentiates between **metadata requests** (which need buffering for URL rewriting) and **generation requests** (which must be streamed directly). If the proxy buffers `streamGenerateContent` or `generateContent` responses, the Go language server times out waiting for the stream to end, causing the app to crash with "terminated due to error."

- **Metadata requests** (`v1internal:*` excluding generation): Buffered, decompressed, URL-rewritten to point back to local proxy
- **Generation requests** (`streamGenerateContent`, `generateContent`): Piped directly without buffering, preserving real-time streaming

### SetCloudCodeURL Blocking

The Antigravity frontend periodically attempts to call `SetCloudCodeURL` which would override the local proxy endpoint with the default Google API URL. The `main.js` process intercepts and **cancels** these requests via `webRequest.onBeforeRequest`, ensuring the language server always routes through the local proxy.

### DSML Tool Call Parser

DeepSeek models (and some other providers) return tool calls in a custom **DSML** (DeepSeek Markup Language) format embedded in text content:

```xml
<DSML|invoke name="search_web">
  <DSML|parameter name="query" string="true">latest news</DSML|parameter>
</DSML|invoke>
```

The proxy automatically detects DSML blocks, parses them into Gemini-format `functionCall` objects, and strips the XML from the displayed text. Native OpenAI `tool_calls` and Anthropic `tool_use` blocks are also supported.

### Anthropic Tool Calling

Claude models (`anthropic` provider) return tool calls as `tool_use` content blocks. The proxy maps these to Gemini-format `functionCall` parts, sets `finishReason: "TOOL_CALL"`, and stores tool call IDs for later matching with `functionResponse` objects in subsequent turns. Both streaming (SSE `content_block_start`/`content_block_delta`) and non-streaming responses are fully handled.

### Security: API Key Encryption

All API keys are encrypted at rest using **AES-256-GCM** via Electron's `safeStorage`. The `cryptoStore.js` module provides:

- **Transparent encryption/decryption**: Keys are encrypted before writing to disk, decrypted on-the-fly when loaded into memory.
- **Auto-migration**: On first run after the encryption update, any legacy plaintext `custom_models.json` config is automatically detected, encrypted, and rewritten.
- **Masked display**: API keys in the UI are shown as `sk-...XXXX` (last 4 chars only) to prevent shoulder-surfing.
- **OS-level key storage**: On macOS, `safeStorage` uses the Keychain; on Windows, it uses DPAPI.

### Dynamic Port Management

The local proxy uses **dynamic port allocation** with automatic fallback:

```javascript
// proxy.js → startProxy()
server.listen(50999, ...);  // Try default port
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    server.listen(0, ...);  // Fallback: let OS pick a free port
  }
});
```

If the default port `50999` is already in use (e.g., by another instance or stale process), the proxy automatically falls back to a random available port (`port: 0`). The `languageServer.js` module reads the dynamically assigned port and injects it into the Go language server's `--api_server_url` argument at startup, ensuring the chain always stays connected.

### Parallel Request Isolation

Multiple models can now make simultaneous requests without cross-contamination. Previously, global variables like `lastToolCallIds` and `lastReasoningContent` could be overwritten by concurrent requests from different models. These have been migrated to **per-model `Map` structures**:

- `modelToolCallIds` (`Map<modelName, { fnName: toolCallId }>`) — scoped tool call ID tracking
- `modelReasoningContent` (`Map<modelName, string>`) — scoped DeepSeek reasoning state
- `activeStreamContexts` (`Map<streamId, context>`) — scoped streaming accumulator

### Schema Validation

The `schemaValidator.js` module provides runtime validation to catch malformed API responses before they reach the IDE frontend, preventing cryptic errors. Exported validators include:

| Function | Validates |
|---|---|
| `validateCandidate` | Individual Gemini candidate structure |
| `validateGenerateContentResponse` | Full Gemini response payload |
| `validateCloudCodeEnvelope` | Cloud Code `{ response, traceId, metadata }` wrapper |
| `validateCustomModel` | Single custom model config (provider enum, URL format) |
| `validateCustomModels` | Array of custom model configs |
| `validateGenerateContentRequest` | Request body structure |
| `validateOpenAiChunk` | OpenAI streaming chunk |
| `validateAnthropicEvent` | Anthropic SSE event type |

## Repository Structure

```
antigravity-add-model/
├── dist/
│   ├── proxy.js              # HTTP proxy + Cloud Code interceptor + format translation
│   ├── languageServer.js     # Modified language server manager
│   ├── ipcHandlers.js        # Custom model CRUD IPC handlers
│   ├── cryptoStore.js        # AES-256-GCM API key encryption/decryption
│   ├── schemaValidator.js    # Runtime schema validation for responses & models
│   ├── preload.js            # Settings UI injection (inline Add Model dashboard)
│   ├── main.js               # App lifecycle + SetCloudCodeURL blocking
│   ├── constants.js          # Port & cert constants
│   ├── paths.js              # Path utilities
│   ├── storage.js            # StorageManager class
│   ├── menu.js               # Application menu
│   ├── tray.js               # System tray
│   ├── updater.js            # Auto-updater
│   ├── customScheme.js       # Plugin scheme handler
│   ├── keybindings.js        # Keyboard shortcuts
│   ├── loadingOverlay.js     # Loading screen overlay
│   ├── types.js              # Type definitions
│   ├── utils.js              # Window management & utilities
│   ├── services/
│   │   └── settingsService.js
│   ├── ideInstall/           # IDE installation wizard
│   ├── __mocks__/            # Test mocks
│   └── test/
│       └── helpers.js
├── repack.ps1                # Portable PowerShell deploy script
├── package.json              # Electron app manifest
└── README.md
```

## Supported Providers

You can configure **multiple models from different providers simultaneously**. All of them will appear together in the model selection dropdown in the Antigravity chat interface, and you can switch between them in real-time.

| Provider | Format | Environment Variable / Key | Default API URL |
|---|---|---|---|
| **OpenAI** | `openai` | `apiKey` (or `OPENAI_API_KEY`) | `https://api.openai.com/v1/chat/completions` |
| **Anthropic** | `anthropic` | `apiKey` (or `ANTHROPIC_API_KEY`) | `https://api.anthropic.com/v1/messages` |
| **Ollama** (Local) | `ollama` | *(None required)* | `http://localhost:11434/v1/chat/completions` |
| **Google AI Studio** | `google` | `apiKey` *(Gemini API Key)* | `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent` |
| **Custom (OpenAI-compatible)** | `custom` | `apiKey` *(Provider API Key)* | E.g. `https://api.together.xyz/v1`, `https://api.groq.com/openai/v1`, etc. |

> [!NOTE]
> For the **Custom** provider, URLs ending in `/v1` automatically get `/chat/completions` appended. It is fully compatible with Together AI, OpenRouter, Groq, Mistral, and any other OpenAI-compliant endpoint.

---

## Installation

### Automatic (Windows)

```powershell
.\repack.ps1
```

This stops Antigravity, packs the repo into `app.asar`, deploys to `%LOCALAPPDATA%\Programs\antigravity\resources\`, and restarts the app.

### Manual (All Platforms)

```bash
npx -y @electron/asar pack . "<antigravity_resources_dir>/app.asar"
```

- **Windows**: `C:\Users\<User>\AppData\Local\Programs\antigravity\resources\`
- **macOS**: `/Applications/Antigravity.app/Contents/Resources/`

---

## Configuration

Models are stored in your home directory at `~/.gemini/antigravity/custom_models.json`. You can easily add them via the **"Add Model"** modal in Settings, or edit the JSON file directly. 

Here is an example of a **fully loaded** `custom_models.json` file configuring **multiple models across all providers at the same time**:

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o (OpenAI)",
      "description": "OpenAI GPT-4o model via official API",
      "provider": "openai",
      "apiKey": "sk-proj-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o"
    },
    {
      "name": "models/claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "description": "Anthropic Claude 3.5 Sonnet via official API",
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-3-5-sonnet-latest"
    },
    {
      "name": "models/gemini-1.5-pro",
      "displayName": "Gemini 1.5 Pro (AI Studio)",
      "description": "Gemini 1.5 Pro via Google AI Studio Key",
      "provider": "google",
      "apiKey": "AIzaSy...",
      "apiUrl": "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
      "externalModelName": "gemini-1.5-pro"
    },
    {
      "name": "models/llama3",
      "displayName": "Llama 3 (Local Ollama)",
      "description": "Local Llama 3 model run on Ollama port 11434",
      "provider": "ollama",
      "apiKey": "",
      "apiUrl": "http://localhost:11434/v1/chat/completions",
      "externalModelName": "llama3"
    },
    {
      "name": "models/deepseek-ai/deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro (Together)",
      "description": "DeepSeek V4 Pro via Together API",
      "provider": "custom",
      "apiKey": "YOUR_TOGETHER_API_KEY",
      "apiUrl": "https://api.together.xyz/v1",
      "externalModelName": "deepseek-ai/DeepSeek-V4-Pro"
    }
  ]
}
```

### Fields Explanation

| Field | Description |
|---|---|
| `name` | Internal model identifier (e.g. `models/gpt-4o`). Must start with `models/` prefix. |
| `displayName` | The friendly name that will appear in the Antigravity chat model dropdown. |
| `description` | Subtitle/description displayed in the Custom Models list in Settings. |
| `provider` | One of `openai`, `anthropic`, `ollama`, `google`, or `custom`. This determines how the request and response formats are translated. |
| `apiKey` | The API credential for the provider. Leave empty `""` for local providers like Ollama. |
| `apiUrl` | The target endpoint. This gets automatically pre-filled by the UI dropdown selection. |
| `externalModelName` | The exact model ID expected by the target provider (e.g., `gpt-4o`, `claude-3-5-sonnet-latest`, `llama3`). |
| `allowUnauthorized` | (Optional) Set to `true` to bypass SSL certificate validation. Useful for internal/self-signed endpoints. Default: `false`. |

## UI Features

### Add Model Modal

Click the **"Add Model"** button in Settings → Models to open a polished modal with:
- Provider dropdown (OpenAI, Anthropic, Google AI Studio, Ollama, Custom)
- Automatic URL pre-filling based on provider selection
- Dynamic Google AI Studio URL generation as you type the model ID
- Smooth enter/exit animations with backdrop blur
- Form validation (required fields: Model ID, API Key, API URL)
- Auto-generated display name if left blank

### Custom Models Dashboard

Below the MCP section in Settings → Models, a "Custom Models" section displays all your configured models with:
- Model name and provider/URL details
- Hover effects on list items
- Delete button with confirmation dialog
- Empty state placeholder when no models are configured
- Automatic refresh after add/delete operations
- **Efficient DOM monitoring**: Uses `MutationObserver` with 200ms debounce instead of `setInterval(1000ms)`, dramatically reducing CPU overhead. The observer auto-disconnects after successful injection and re-attaches on SPA page transitions via URL change detection.

### SSL Bypass (Self-Signed / Internal CAs)

For enterprise environments using self-signed certificates or internal Certificate Authorities (e.g., corporate proxy servers, private API endpoints), add `"allowUnauthorized": true` to your model config:

```json
{
  "name": "models/internal-model",
  "displayName": "Internal LLM (Corporate)",
  "description": "Company-hosted model behind self-signed cert",
  "provider": "custom",
  "apiKey": "...",
  "apiUrl": "https://llm.internal.company.com/v1",
  "externalModelName": "llama3",
  "allowUnauthorized": true
}
```

This sets `rejectUnauthorized: false` on the HTTPS agent, allowing connections to servers with untrusted certificates.

## Contributing

Pull requests welcome. Feel free to add new provider adapters inside `dist/proxy.js`.

## License

MIT License
