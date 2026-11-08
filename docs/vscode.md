# Google Antigravity extension for VS Code

The official **Google Antigravity** extension for Visual Studio Code
(`google.google-antigravity`) runs the same `agy --hub` backend as Antigravity
IDE 2.6.0. You do not have to change any file in VS Code or in the extension.
The backend reads its Cloud Code address from the `CLOUD_CODE_URL` environment
variable, and the extension passes VS Code's own environment to the backend.
Point that variable at the local proxy and saved models appear in the
Antigravity model picker next to the Google models.

## Set up

1. Build this repository as described in the [README](../README.md).
2. Start the proxy and add your models in the manager that opens:

   ```sh
   npm run proxy:start -- --open
   ```

3. Quit VS Code completely, including all windows. If a VS Code window is still
   open, the `code` command reuses it and the new variable is ignored.
4. Start VS Code from a terminal with the variable set.

   Windows PowerShell:

   ```powershell
   $env:CLOUD_CODE_URL = "http://127.0.0.1:50999"; code
   ```

   macOS or Linux:

   ```sh
   CLOUD_CODE_URL=http://127.0.0.1:50999 code
   ```

5. Sign in to Antigravity in VS Code as usual, then open its model picker.

Keep the proxy running while you use Antigravity. If it stops, Antigravity
cannot reach Cloud Code until you start the proxy again or restart VS Code
without the variable. To use another port, pass `--port` to `proxy:start` and
put the same port in the URL.

To use this every time, you can set `CLOUD_CODE_URL` as a user environment
variable. It then also applies to Antigravity IDE 2.6.0 and the `agy` command
line, so only do this if the proxy always runs when you log in. Remove the
variable to go back to the normal setup.

## What was checked

- The published extension **1.11.0** (Open VSX, 2026-11-05, SHA-256
  `28a8542b1b0f62fb998609054d97a69b67cc9bfacb6eb974512ec6e496e8f4b8`) builds
  the backend environment from `process.env` and only adds values such as
  `HOME`, `AGY_ENABLE_HUB` and proxy settings. It never removes
  `CLOUD_CODE_URL`. It starts `agy --hub` with the same arguments as IDE 2.6.0.
- `agy` reads `CLOUD_CODE_URL` to override its Cloud Code server. The string is
  in `agy` v1.5.1, and the variable was used live on Linux in
  [issue #42](https://github.com/vahapogut/antigravity-add-model/issues/42).
- The full flow has **not** been tested in VS Code yet. Please report your
  result in the issue tracker with the extension version (Extensions view), your
  OS and the log lines described below.

## Limits

- **Remote windows** (WSL, SSH, Dev Containers): the extension and `agy` run on
  the remote machine. Run the proxy there and set the variable in the
  environment the remote VS Code server starts with. This is untested.
- **VSCodium and other forks** install the same extension from Open VSX, so the
  same variable should apply. This is untested.
- If chat fails with `maxMessageTokens must be positive, got 0`, please report
  it with the model's placeholder ID. This was seen on IDE 2.6.0 in
  [issue #42](https://github.com/vahapogut/antigravity-add-model/issues/42).
- The standalone desktop app and Antigravity IDE use their own adapters:
  [desktop installer](../README.md) and [IDE setup](ide.md).

## Troubleshooting

- **Proxy log:** `~/.gemini/antigravity/.ide-proxy/service.log` (Windows:
  `%USERPROFILE%\.gemini\antigravity\.ide-proxy\service.log`). Lines such as
  `[Proxy] Request: POST /v1internal:fetchAvailableModels` show that the backend
  uses the proxy. When the Google models are missing, a
  `Native model catalog unavailable` warning gives the reason.
- **Extension log:** in VS Code, open **View → Output** and pick **Antigravity**.
  The `[LAUNCH] Spawning … --hub …` line shows the backend start, and
  `[HUB STDERR]` lines show backend errors.
- If no request reaches the proxy, VS Code was most likely already running when
  you set the variable. Quit every window and try again.
