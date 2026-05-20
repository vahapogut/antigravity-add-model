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

| File | Purpose |
|---|---|
| `dist/proxy.js` | Local HTTP proxy: intercepts Cloud Code API, merges custom models, translates formats, wraps responses |
| `dist/languageServer.js` | Starts proxy on app launch, points language server to local proxy |
| `dist/ipcHandlers.js` | Backend IPC: `storage:get-custom-models`, `storage:save-custom-model`, `storage:delete-custom-model` |
| `dist/preload.js` | UI injection: "Custom Models" dashboard in Settings → Models tab, inline Add Model modal with animations |
| `dist/main.js` | App lifecycle: intercepts & blocks `SetCloudCodeURL` requests to prevent frontend from overriding proxy endpoint |
| `repack.ps1` | PowerShell script: stop Antigravity, repack `app.asar`, restart |

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
3. Proxy detects custom model match (by slug or MODEL_PLACEHOLDER_M* enum)
4. Extracts reqJson.request → maps systemInstruction + contents to OpenAI format
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

The proxy automatically detects DSML blocks, parses them into Gemini-format `functionCall` objects, and strips the XML from the displayed text. Native OpenAI `tool_calls` are also supported.

## Repository Structure

```
antigravity-add-model/
├── dist/
│   ├── proxy.js              # HTTP proxy + Cloud Code interceptor + format translation
│   ├── languageServer.js     # Modified language server manager
│   ├── ipcHandlers.js        # Custom model CRUD IPC handlers
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
├── repack.ps1                # PowerShell deploy script
├── package.json              # Electron app manifest
└── README.md
```

## Supported Providers

| Provider | Format | Environment Variable | Example API URL |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` |
| Ollama | `ollama` | *(none)* | `http://localhost:11434/v1/chat/completions` |
| Google AI Studio | `google` | *(in apiKey field)* | `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent` |
| Custom (OpenAI-compatible) | `custom` | *(in apiKey field)* | `https://api.together.xyz/v1` |

Custom provider maps to OpenAI format automatically. URLs ending in `/v1` get `/chat/completions` appended.

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

## Configuration

Models are stored in `~/.gemini/antigravity/custom_models.json`. You can use the inline "Add Model" form in **Settings → Models** or edit the file directly:

```json
{
  "models": [
    {
      "name": "models/deepseek-ai/deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro",
      "description": "DeepSeek V4 Pro via Together API",
      "provider": "custom",
      "apiKey": "YOUR_TOGETHER_API_KEY",
      "apiUrl": "https://api.together.xyz/v1",
      "externalModelName": "deepseek-ai/DeepSeek-V4-Pro"
    }
  ]
}
```

### Fields

| Field | Description |
|---|---|
| `name` | Internal identifier, slug format preferred |
| `displayName` | Shown in model dropdown and settings |
| `description` | Shown in model list |
| `provider` | `openai`, `anthropic`, `ollama`, `google`, or `custom` |
| `apiKey` | API key for the external provider |
| `apiUrl` | Base URL for the API endpoint |
| `externalModelName` | Model name sent to the external API |

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

## Contributing

Pull requests welcome. Feel free to add new provider adapters inside `dist/proxy.js`.

## License

MIT License
