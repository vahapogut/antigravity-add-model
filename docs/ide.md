# Antigravity IDE setup

The VS Code-based **Antigravity IDE** and the standalone Electron desktop agent
have different runtimes. Use these commands for the IDE; use `deploy.mjs` for the
standalone app. The IDE adapter changes the verified `jetski.cloudCodeUrl` user
setting and starts an independent local proxy. It does not replace vendor code.

The verified releases are **Antigravity IDE 2.5.5** and **2.6.0**, both based on
**VS Code 1.107.0**. `ide:check` reports these separately as `ideVersion` and
`version`. IDE 2.6.0 keeps the `jetski.cloudCodeUrl` setting and also copies that
loopback URL into the hub process as `AGY_LLM_GATEWAY_URL`. Its language server
is the downloaded `agy` hub, not the 2.5.5 `--cloud_code_endpoint` launcher.
IDE 2.6.0 was verified live on Windows. The macOS build reports the same release
commit, and the Linux build (commit `895a0667…`, installed under
`/opt/antigravity-ide`) is recognized from a user report. Both are accepted only
when the launcher matches the inspected code, but neither has been confirmed end
to end yet. Please report the result in the issue tracker.
Install the IDE edition from the [official download page](https://antigravity.google/download).

## Check, configure and launch

Build this repository with Node.js 22.13 or newer:

```sh
npm ci --ignore-scripts
npm run build
npm run ide:check -- --resources "/path/to/Antigravity IDE/resources"
npm run ide:apply -- --resources "/path/to/Antigravity IDE/resources"
npm run proxy:start -- --open
npm run ide:launch -- --resources "/path/to/Antigravity IDE/resources"
```

`--resources` also accepts an installation root or a macOS `.app`. Close the IDE
before applying settings, then use `ide:launch` to start it. Launch waits for the
owned proxy to become healthy before opening the verified IDE executable. It
passes the configured user-data directory so the correct settings are loaded.
It does not install an OS startup task: opening the ordinary IDE shortcut still
requires the proxy to be running.

Preflight requires recognized Antigravity product metadata and an unpacked
`app/out/main.js` entry point. It accepts an extension that declares
`jetski.cloudCodeUrl`, the inspected IDE 2.5.5 core implementation, or the
inspected IDE 2.6.0 hub launcher. The 2.5.5 release
uses the setting internally without declaring it in the extension manifest;
preflight verifies its release commit, product/extension identity and both core
and language-server endpoint code. Unsupported layouts fail before settings change.
An IDE packaged only in `app.asar` is not supported by this adapter.

The default loopback port is **50999**. To change it, supply `--port 51001` to
`ide:apply` and `proxy:start`; launch reads the configured port. Restore before
changing an already managed endpoint. A busy port is an error, never a silent
fallback to a different port.

Optional arguments:

| Argument | Purpose |
| --- | --- |
| `--settings "/path/User/settings.json"` | Explicit settings file, including a portable user-data directory. |
| `--data-dir "/path/model-data"` | Model/credential/service state directory for `proxy:start` and `ide:launch`. Use the same directory for both and for proxy status/stop. |
| `--executable "/path/Antigravity.exe"` | Choose an executable next to the recognized resources; arbitrary executables are refused. |

`apply`/`restore` support explicit named-profile settings, but `ide:launch` only
supports `USER_DATA_DIR/User/settings.json`. For a named profile, start the proxy
and select that profile in the IDE yourself.

Complete the IDE's own Google sign-in and onboarding. The adapter preserves this
login flow. Its proxy starts account setup on the production Cloud Code endpoint
and follows the returned tier's endpoint choice; routing state is isolated per
bearer digest and expires after one hour. A browser authentication-success page
can appear before IDE account setup finishes, so confirm sign-in in the IDE too.

After a proxy restart, bearer refresh or routing-cache expiry, the proxy queries
`loadCodeAssist` with the same account identity before forwarding native
generation. It restores the account's production/daily endpoint choice without
resending generation or changing account tier. A failed lookup is reported
explicitly. Genuine provider quota limits still apply.

## Model manager and credentials

`proxy:start -- --open` opens the browser manager. It has the same model editor,
provider discovery, import/export, Google account controls and gateway connection
as the desktop addon. **Diagnostics** shows measured recent requests;
**Test generation** explicitly sends a small request that can consume provider
quota. The ordinary **Test connection** continues to check connectivity/catalogs.

The manager URL includes an access token in its fragment. The page moves this
token into tab session storage; it is not sent as a URL query or logged in HTTP
paths. Management actions require the token and the exact loopback origin.
Keep that URL private. Generation remains available to local IDE processes;
the service rejects cross-origin browser requests and unrecognized Host headers.
Use the separate authenticated [gateway](../gateway/README.md) for remote access.

By default models use `~/.gemini/antigravity/custom_models.json`. Node service
credentials use AES-256-GCM with a local user key in that directory. Credentials
encrypted by Electron's OS `safeStorage` cannot be decrypted by plain Node:
re-enter them in the manager, or use a separate `--data-dir` for the IDE.
The manager's optional Google account pool is separate from the IDE's own login.
It uses the [explicit account setup](configuration.md#google-cloud-code-account-pools)
described in the configuration guide.

The web manager also shows grouped account quotas/reset times, reconnect
actions, preferred-account selection and the optional matching-pool native
failover setting. See [quota controls](configuration.md#quota-panel-and-preferred-accounts).
The addon search field inside the standalone application's model dropdown is
specific to that renderer; the IDE retains its own native picker. Saved models
are injected into that native picker through the catalog as described below.

Verified on Windows Antigravity IDE 2.5.5 on **2026-10-15**:

- A saved local OpenAI-compatible model appeared in the native picker and its
  streamed response reached the chat. A model ID ending in `-free` stayed on its
  configured local provider.
- A real OpenRouter `nvidia/nemotron-3.5-lightning:free` request returned HTTP 200
  and the correct arithmetic answer in the IDE.
- The web manager loaded three quota entries from two controlled local test
  pools. Selecting the second account as preferred routed the next IDE request
  through that account and displayed its response.
- OpenCode discovery returned 87 models, but a real keyless `big-pickle`
  generation request returned the provider's client-restriction HTTP 403. The
  IDE surfaced its generic execution error; the manager and provider guide
  explain the restriction. Catalog access does not imply generation access.

The Google pool check used local quota/account fixtures, not two live Google
accounts. Native quota failover, OAuth reconnect, cancellation and interrupted
streams are covered by automated tests; a two-account live Google quota
exhaustion scenario was not exercised in this session.

## Workspace files and artifacts

Custom models sometimes attach `ArtifactMetadata` to an ordinary workspace file,
causing the IDE to reject it as an invalid artifact path. The proxy now removes
that optional field automatically when the current native tool schema and IDE
context identify a workspace file outside the conversation's artifact directory.
No manual reminder to the model is needed for these recognized calls.

Real artifact metadata is preserved. Unknown tool schemas, missing or conflicting
context, relative or ambiguous paths, and files outside the declared workspaces
are passed through unchanged for the IDE to validate. This does not change file
permissions or the requested target, contents or overwrite behavior. See the
[real IDE test results](verification-artifact-metadata.md).

## Native model identities and capacity

IDE 2.5.5 builds its native picker from the Cloud Code model catalog and its
sort/group entries. The proxy adds configured models to both and allocates a
distinct native enum identity for each saved model, including effort variants.
The browser manager and desktop preload receive those same authoritative IDs.

The inspected IDE schema has **651 placeholder values**. Native-model
reservations and retained assignments for deleted models consume part of that
pool, so this is an upper bound rather than a promise of 651 extra entries.
Models beyond the available native slots remain editable and accessible through
their direct API aliases; the manager explains why native picker injection is
unavailable. Provider discovery and saved configuration are not limited to this
native picker capacity.

Assignments live in `<data-dir>/custom_model_identities.json`. They survive
display-name changes, model reordering and service restarts. Deleted-model
assignments remain reserved so a cached IDE selection cannot silently select a
different provider. Back up this file with `custom_models.json` and the local
credential key. Restoring only the model list can lose these stable identities.

## Delegate to custom models with MCP

IDE 2.5.5 does not expose the native `invoke_subagent` tool in the tested sessions.
Its supported [MCP integration](https://antigravity.google/docs/mcp/) provides a
separate path: a built-in or custom parent can call `delegate_to_model`, send a
text task to one saved custom model, and receive its answer in the same chat.

Install dependencies/build, configure your custom model in the browser manager,
and start the proxy with the same data directory used by the MCP server:

```sh
npm ci --ignore-scripts
npm run build
npm run proxy:start -- --data-dir "/path/to/model-data"
npm run ide:mcp -- apply --data-dir "/path/to/model-data"
```

The installer adds only the `custom-models` server to
`~/.gemini/config/mcp_config.json`, preserving other servers and JSONC comments.
It writes absolute Node/script paths and stores no API key in the MCP config.
Keep this repository and its dependencies at that path. It refuses an existing
unmanaged server with the same name. Empty or comment-only starter files are
supported and restored byte-for-byte when the managed configuration is removed.
For a different configuration location, pass `--config "/path/mcp_config.json"`
to apply/status/restore. Check **View raw config** in the IDE's MCP manager for
the active location: the tested IDE 2.5.5 loaded the global config above, but did
not discover the workspace `.agents/mcp_config.json` during the live check.

In the IDE, open **… → MCP Servers → Manage MCP Servers** and refresh, or restart
the IDE. The server provides two tools:

- `list_custom_models`: lists enabled saved names, with a `nextCursor` when more
  models are available. Pass that cursor to retrieve the next page.
- `delegate_to_model`: accepts the exact saved `model`, a `prompt`, and optional
  text `context`. Only the supplied task/context go to that provider. Results
  include completion/truncation metadata.

For example: “Use the custom-models tools to delegate a summary of this text to
`models/my-openrouter-model`, then show me its answer.” The selected parent must
support tool calling and have working provider access; a native parent's quota
error prevents it from invoking any tool.

Each delegation is an independent **text-only worker**. It does not open an IDE
child window, inherit chat history, read files, execute commands, or call tools.
The parent can explicitly supply relevant text as context. Calls use exactly
the selected model without fallback to another model, allow four concurrent
workers, and cap task/context at 64 KiB, output at 8,192 tokens and runtime at
120 seconds. Cancelling the MCP call cancels its provider request. Provider
usage charges and saved account policies still apply.

The MCP process communicates over stdio and authenticates to the existing owned
loopback proxy. It never starts a proxy automatically. For a manual MCP config,
use Node directly with `scripts/model-delegation-mcp.mjs --data-dir ...`; do not
use `npm run` as the stdio command because npm banners corrupt MCP output.

```sh
npm run ide:mcp -- status
npm run ide:mcp -- restore
```

Restore checks the managed entry and backup integrity, restores the original
file when unchanged, and preserves unrelated later edits. Backups live in the
adjacent `mcp_config.json.antigravity-custom-models` directory. A manual change to
the managed entry is reported as a conflict rather than overwritten.

## Status and recovery

```sh
npm run ide:status -- --resources "/path/to/Antigravity IDE/resources"
npm run proxy:status
npm run proxy:stop
npm run ide:restore -- --resources "/path/to/Antigravity IDE/resources"
```

Settings backups and a hash-checked manifest live beside the settings file in
`settings.json.antigravity-model-patch`. Restore returns exact original bytes
when unchanged, or restores only the managed property while preserving unrelated
later edits. It refuses a conflicting manual endpoint change or damaged backup.
Keep these backups until the adapter is removed. Comments and trailing commas
are supported; duplicate keys and malformed JSONC are rejected.

Service state/logs live under `<data-dir>/.ide-proxy/`. Start is idempotent for
the same directory and port. Stop authenticates the owned instance; it does not
kill a process just because it uses that port or an old recorded PID.

## Validation boundary

Installer fixtures cover Windows/macOS/Linux layouts, settings preservation,
restore conflicts and startup ordering. HTTP fixtures test the real Node proxy,
encrypted model persistence, browser management, local generation and lifecycle.

| Check | Result |
| --- | --- |
| Official IDE 2.5.5 Windows and Linux artifacts | Download hashes verified; Windows Google LLC signature verified; actual runtime and protobuf schema inspected. |
| Adapter against authentic resources | Preflight accepts both extracted builds through the verified hidden core setting. |
| Live Windows IDE login | Confirmed signed in after correcting buffered HTTP forwarding and initial Cloud Code host selection. |
| Extracted vendor catalog/picker functions with 320 configured models | Produced 320 distinct native selections, including duplicate display labels; enum symbols checked against the official descriptor. IDs survived reorder/rename and preserved native reservations. |
| Live Windows IDE 2.5.5 native picker | Displayed the configured test model and its low/medium/high effort variants; the base model was selected from the real picker. |
| Live Windows IDE 2.5.5 streamed chat | An actual IDE `streamGenerateContent` request reached a local OpenAI-compatible `/v1/chat/completions` endpoint, returned HTTP 200 SSE, and rendered `IDE LIVE ROUTE OK` in the native chat. |
| Live effort variant routing | Selecting the medium variant in the native picker sent `reasoning_effort: "medium"` to the same upstream model and rendered a second successful streamed response. |
| Live automatic compaction on 2026-10-14 | A UI-created conversation reached the native checkpoint threshold using a local OpenAI-compatible fixture. The configured custom model received normal `xhigh` requests, a native session-summary request at `low`, and a subsequent normal request at `xhigh`. Native state confirmed successful summary storage without fallback; the next IDE reply displayed a marker introduced only in the summary. The acceptance run used catalog configuration, without a session RPC override or injected summary prompt. Remote model latency and reasoning savings were not measured. |
| Live adapter recovery and launch | Restored and reapplied the isolated profile setting; managed launch started the real Windows executable and its owned proxy. The interactive IDE window is shown rather than hidden by the background-service launch flag. |
| Live Windows IDE 2.5.5 native parent → custom-model MCP delegation | Completed with the real Google Gemini 3.8 Flash High parent. After the user's one-time approval of each tool, it called `list_custom_models` and `delegate_to_model` with `models/ide-native-child`. The local deterministic OpenAI-compatible provider received `/v1/chat/completions` with the exact child model and no tools; its unique verification marker appeared in the IDE's final parent reply. Both delegation and final native generation returned HTTP 200. This verifies a text-only MCP worker, not native child-agent UI. |
| Live native parent → real OpenRouter model | Gemini 3.8 Flash High delegated a short arithmetic task to `nvidia/nemotron-3.5-lightning:free` through the MCP tools. One actual HTTPS request reached `openrouter.ai/api/v1/chat/completions` and returned HTTP 200 with the requested model and `stop`. The provider's answer, MCP result and final Gemini reply had identical SHA-256 text hashes; the IDE displayed the verification marker and `137x29=3973`. The selected model's input/output prices were zero in OpenRouter's live catalog at test time. |

The extracted-function check uses captured message constructors. It verifies the
vendor selection logic and enum values; it does not substitute for a complete
protobuf decode or live IDE interaction.

The picker and custom-provider live checks ran on **2026-10-12**; native-parent
and MCP delegation checks ran on **2026-10-13**, using an isolated Windows profile.
Custom-provider checks include a local OpenAI-compatible fixture and the real
OpenRouter free endpoint above. The remote run used the user's API key entered
in the local model manager and one short task; no credentials are committed or
written to verification logs. Linux source inspection and macOS installer
fixtures are separate checks; their desktop UI flows and paid custom-provider
generation were not part of these live runs.

This release obtains its picker through `fetchAvailableModels` and native
unified-state updates; it does not require a `GetUserStatus` RPC injection.
Other IDE releases need their own compatibility evidence. If models are absent,
include the IDE version, OS, `ide:check` output and request path without
credentials. The standalone desktop binary patch is a different installer.
