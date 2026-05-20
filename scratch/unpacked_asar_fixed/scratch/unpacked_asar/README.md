# Antigravity Model Enabler (Open-Source Patch)

This repository contains an open-source patch for **Google Antigravity**, an agentic desktop application. 

By default, Antigravity only supports built-in Gemini models and does not allow users to connect to external model APIs. This patch hooks the application's internal language server and routes generative requests through a local Node.js proxy server, enabling seamless integration of external models (OpenAI, Anthropic, Ollama, etc.) while preserving all core Gemini features and authentication.

## How it Works

1. **Local Proxy Sunucusu (`dist/proxy.js`)**: 
   - Intercepts requests to the Gemini API host (`generativelanguage.googleapis.com`).
   - Merges custom models from `custom_models.json` with Google's original models list when retrieving available models.
   - For custom model requests, it automatically translates request bodies into the correct format for the external provider (OpenAI, Anthropic, Ollama), queries the external endpoint, and maps the response back into the Gemini format expected by the app.
   - For standard models, it transparently forwards all traffic preserving original OAuth authorization headers and keys.

2. **Language Server Hook (`dist/languageServer.js`)**:
   - Launches the local proxy server on startup.
   - Points the Go-based language server's `--api_server_url` flag to `http://localhost:<proxyPort>` instead of the hardcoded Google API endpoint.

## Repository Structure

- `dist/proxy.js` - The local HTTP proxy and model API mapping service.
- `dist/languageServer.js` - Modified version of the main-process manager that integrates and routes through the proxy.
- `repack.ps1` - Helper PowerShell script to package the files into `app.asar` and replace it inside your local Antigravity installation folder for testing.

## Installation Guide

To install and apply this patch, you can choose either the **Automatic** method (Windows only) or the **Manual** method (all platforms).

### Method 1: Automatic Installation (Windows - Recommended)

1. Clone this repository to your local machine.
2. Open a PowerShell terminal in the repository directory and run:
   ```powershell
   .\repack.ps1
   ```
   *Note: This script will close your running Antigravity app, compile/pack the repository into `app.asar`, deploy it to your installed program directory, and restart the app.*

### Method 2: Manual Installation (macOS, Linux, Windows)

If you are on macOS or Linux, or prefer to deploy the patch manually, follow these steps:

1. **Locate your Antigravity installation's resource directory**:
   - **Windows**: `C:\Users\<YourUsername>\AppData\Local\Programs\antigravity\resources\`
   - **macOS**: `/Applications/Antigravity.app/Contents/Resources/`
   - **Linux**: `/usr/share/antigravity/resources/` (or your specific installation path)

2. **Backup your original code package**:
   - Go to the resources directory and locate the `app.asar` file.
   - Rename `app.asar` to `app.asar.bak` to keep a backup.

3. **Pack and Deploy the Patch**:
   - Open a terminal in the cloned repository directory.
   - Build and pack the patched code directly into the installation directory using `asar`:
     ```bash
     npx @electron/asar pack . "<path_to_antigravity_resources>/app.asar"
     ```
     *(Example for Windows: `npx @electron/asar pack . "C:\Users\<YourUsername>\AppData\Local\Programs\antigravity\resources\app.asar"`)*

4. **Restart the Antigravity Application**:
   - Launch the desktop application again. The proxy and model enabler patch will now be active!

---

## Custom Models Configuration

Upon the first restart, the proxy will create a configuration file at:
`~/.gemini/antigravity/custom_models.json`

Open this file to add your API keys and custom model endpoints:

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o (OpenAI via Proxy)",
      "description": "OpenAI GPT-4o model redirected through proxy",
      "provider": "openai",
      "apiKey": "sk-proj-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o"
    },
    {
      "name": "models/claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet (Anthropic via Proxy)",
      "description": "Anthropic Claude 3.5 Sonnet model redirected through proxy",
      "provider": "anthropic",
      "apiKey": "xkeys-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-3-5-sonnet-latest"
    }
  ]
}
```

## Contributing
Pull requests are welcome. Feel free to open issues or contribute new provider adapters (e.g. Cohere, Groq, DeepSeek) inside `dist/proxy.js`!

## License
MIT License
