# Changelog

Release history preserved from the project README. Historical entries describe the behavior of their release; see [compatibility and recovery](docs/compatibility.md) for current installation guidance.

### Unreleased — Windows 2.0.6 native picker verification

- Document the manually verified Windows 10 / standalone Antigravity 2.0.6 case where the Language Server called the hard-coded Cloud Code model-list endpoint instead of the local proxy. Record the exact post-patch request path, proxy log signatures, fixed port (50999), recovery safeguards and environment details that were not captured. The endpoint patch and binary-patch regression tests already exist; this entry adds reproducible verification notes rather than duplicating the implementation.

### Unreleased — Automatic workspace artifact metadata correction

- Prevent custom models from classifying ordinary workspace files as artifacts by sending optional `ArtifactMetadata`. Use the current native IDE workspace paths, artifact directory and tool schema to remove the misplaced field before execution, without changing the requested path, contents or overwrite setting. Genuine artifact calls and ambiguous/custom contexts remain unchanged.
- Apply the correction to OpenAI, Anthropic and Google response formats, including streaming and JSON fallback. Record reasoning against the corrected tool arguments so the next tool turn can still recover its history. Include the new module in standalone deployment.
- Verify on Windows Antigravity IDE 2.5.5 with a real OpenRouter model: normal file creation/editing, genuine artifact creation, and a deliberately malformed metadata call corrected automatically on its first attempt. All 1,607 tests pass (two existing skips); see [live verification](docs/verification-artifact-metadata.md).

### Unreleased — Dependency security updates

- Upgrade Chrome DevTools MCP to 1.12.0, Electron Updater to 6.8.11 and Vitest to 4.1.12. Refresh vulnerable transitive dependencies, including the updater's redirect handling, HTTP request parsing, YAML/URI parsing, and the test/build toolchain.
- Upgrade the optional gateway's Undici HTTP client to 7.30.1 and raise its minimum supported dependency version. Keep reproducible lockfiles for both installations.
- On 2026-10-24, `npm audit` reports zero known vulnerabilities for both the main project (including development dependencies) and the gateway, down from 14 and 1 affected package records respectively. Clean installs, both builds, 1,537 main-project tests, 242 gateway tests and the desktop-to-gateway integration check pass; two existing main-project tests remain skipped.

### Unreleased — Preserve reasoning across tool calls

- Address the reasoning loss reported in [PR #29](https://github.com/vahapogut/antigravity-add-model/pull/29): use one assistant-message mapping for normal and tool-call history so each turn retains its own `reasoning_content`, separate from visible text. Preserve tool identifiers, arguments, results and message order.
- Preserve provider reasoning in nonstreaming tool-call responses, including recognized DSML calls, so subsequent requests can replay it. Add regression coverage for sequential and parallel calls, response round trips and local HTTP continuations. Provider-specific use of reasoning remains outside this protocol-level guarantee.
- Recover completed tool-turn reasoning when the native IDE omits thought parts from history. Keep recovery bounded and in memory, scoped to the conversation, configured provider and exact tool-call group; reject missing identity, changed calls, ambiguous reused IDs and failed responses. Clear recovery state on service shutdown.
- Verify two real native file reads and successful continuation in Antigravity IDE 2.5.5 with OpenRouter's Nemotron 3.5 Lightning (free). All three response-to-history reasoning fingerprints matched; see [live test results and boundaries](docs/verification-pr29.md).

### Unreleased — Account fleet and visible context estimate

- Add collapsible Google account cards with enable/disable, label editing, removal, per-pool Preferred/Automatic selection and a native fallback switch. Preserve each pool's credentials, project and quotas; serialize mutations to prevent stale saves from overwriting account changes.
- Display Gemini and Claude quotas with provider-reported plan labels and relative reset times. Scope quota observations by credentials, OAuth client, project and endpoint; handle structured quota failures and bounded retry/reset metadata while retaining exact-model Cloud Code fallback.
- Add a read-only context ring beside recognized native model selectors. Label visible transcript estimates with `~` and unavailable usage with `?`; preserve configured limits and offer an explicit, bounded public catalog lookup for missing limits. Handle conversation/model switches, compaction, renderer replacement and stale responses without rewriting configuration.
- Verify real Antigravity 2.23.1 message generation, model switching, compaction, account controls, full restart and conversation continuation with a local deterministic provider. See [test results and boundaries](docs/verification-pr28.md).

### Unreleased — Compaction resume and account panel fixes

- Address [issue #26](https://github.com/vahapogut/antigravity-add-model/issues/26): remove historical subagent route markers from JSON `initialPrompt` snapshots before scanning active routes. Compacted parent conversations can resume after a proxy restart without binding to a quoted child route; actual expired, ambiguous or parent-replacing routes still fail explicitly.
- Address [issue #25](https://github.com/vahapogut/antigravity-add-model/issues/25): read grouped and top-level Google quota buckets together, retaining distinct quota families and unknown values. Display a shared Google email once with all assigned model pools, keeping each pool's credentials, project, quotas and actions separate.
- Preserve model-list scroll position after deletion and return keyboard focus to an adjacent model without scrolling. Build replacement content before swapping it into the page, and respect focus changes while a refresh is pending.

### Unreleased — Account quota controls and model search

- Add grouped Google quota cards with supplied reset times to desktop settings and the IDE web manager, plus per-pool preferred-account, reconnect and removal actions. Preserve new OAuth tokens during reconnect and retain the owning model when querying accounts across multiple pools.
- Add opt-in native quota failover through one explicitly configured matching pool. Preserve upstream-model quota scope, account concurrency until stream completion, bounded deadlines and cancellation, including interrupted responses and proxy shutdown.
- Add keyboard search to the standalone model dropdown.
- Update OpenCode discovery and keyless requests to the documented inference API. Preserve saved endpoints and real tool declarations, scope provider-specific handling correctly, and report service restrictions without pretending successful generation. The current public free endpoint returned a client-restriction 403 in live testing; see [OpenCode setup](docs/providers.md#opencode-and-keyless-requests).

### Unreleased — Windows update blockers and bounded shutdown

- Follow up on [issue #22](https://github.com/vahapogut/antigravity-add-model/issues/22): bound the proxy's shutdown drain, cancel its unfinished upstream requests, and signal the legacy desktop language server concurrently. Cancel pending language-server startup when shutdown begins, so unfinished requests or a late spawn cannot leave that quit path hanging.
- Detect the IDE's actual application, installer and update-readiness mutexes with a read-only Windows probe. Recheck processes and mutexes after backup verification, before restoring files or settings.
- Refuse to report proxy shutdown as successful when an unresponsive service still has a live or uninspectable recorded process; wait for process exit after authenticated shutdown. Preserve unresolved records and never forcibly terminate a process from the service CLI. Avoid sending stale management credentials when the recorded owner has exited.
- Verify the official IDE 2.5.5 installer's running-app gate and the missed setup-mutex defect on Windows: the old preflight reported ready while setup remained open; the new preflight blocked preparation, then passed after setup was canceled. No installation was performed. The reporter's failure persisting after reboot still needs their installation details; see [verification and recovery](docs/compatibility.md#windows-installer-asks-to-close-antigravity).

### Unreleased — Native checkpoint threshold and Windows update preparation

- Address [issue #21](https://github.com/vahapogut/antigravity-add-model/issues/21) with an optional per-model **Compaction threshold (%)**. Preserve actual model capacity, reserve output space, and apply the same validated native settings through the proxy catalog and desktop fallback. Blank settings retain native defaults; see the [85k example](docs/configuration.md#compaction-threshold).
- Cap native custom-model summary output when the model's advertised output limit is below the IDE's default 8,192 tokens, preventing native checkpoint configuration rejection.
- Bridge IDE 2.5.5's validation-before-override behavior with a bounded native catalog compatibility value when explicitly configuring a threshold. Keep the saved/provider context and checkpoint policy based on the actual model capacity; reject budgets too small to safely pass native defaults. Explain the displayed compatibility value in the editor and guide.
- Verify the 85k/8192/50% configuration in Windows IDE 2.5.5 with a local deterministic provider: automatic summary before history trimming, successful native storage without fallback, then a continuation using the stored summary. The UI-created conversation used ordinary native RPC continuations with unchanged configuration; see [validation details](docs/configuration.md#compaction-threshold).
- Add `update:check` and `update:prepare` for [issue #22](https://github.com/vahapogut/antigravity-add-model/issues/22): inspect Windows process identities and verified restore data, restore managed changes, and stop only the authenticated owned proxy. Refuse stale backups and unresolved process blockers; preserve models and credentials. The original installer hang is still awaiting reproduction details; see [recovery guidance](docs/compatibility.md#windows-installer-asks-to-close-antigravity).

### Unreleased — Live IDE compaction verification

- Follow up on [issue #20](https://github.com/vahapogut/antigravity-add-model/issues/20) by recognizing the session-summary template captured from a real IDE 2.5.5 automatic checkpoint. Its summary requests previously retained ordinary chat effort.
- When a custom model explicitly selects a compaction effort, advertise the IDE's per-model checkpoint setting to summarize with that custom model. Inherited settings and built-in model entries keep their existing behavior.
- Verify the complete flow in the Windows IDE UI with a local OpenAI-compatible provider: normal `xhigh`, automatic summary `low`, successful native checkpoint without fallback, then normal `xhigh` with the summary's private verification marker displayed in the reply. No vendor files or summary prompts were injected. Remote reasoning savings and latency were not measured; see [configuration](docs/configuration.md#compaction-effort).

### Unreleased — Antigravity account sign-in and project preparation

- Follow up on [issue #19](https://github.com/vahapogut/antigravity-add-model/issues/19) with **Antigravity account** sign-in using the personal-account OAuth profile from a recognized installed IDE 2.5.5 build. Preserve PKCE, state validation, cancellation and the existing custom-client option; unknown installations report an error without fallback.
- Prepare the Cloud Code project and service endpoint after explicit Antigravity sign-in, with a **Prepare account** action for existing entries. First-time enrollment is limited to the free tier and remains subject to Google's eligibility decisions. Preserve masked credentials, encrypted storage, project and endpoint through refresh, discovery and generation.
- Use a consistent application-owned `User-Agent` across Cloud Code preparation, catalog, quota and generation requests, fixing the catalog 403 encountered during live validation. Retain newly refreshed credentials in encrypted storage even if subsequent account preparation fails or is cancelled.
- Verify a real account on **2026-10-14** with browser OAuth through the recognized official IDE 2.5.5 profile, project preparation, catalog access (HTTP 200, 19 models), quota access (HTTP 200), forced token refresh with encrypted persistence, and `gemini-2.5-flash` generation (HTTP 200, `OK`). Two-account HTTP 429 rotation remains verified with local fixtures only; see [validation details](docs/configuration.md#verified-google-account-flow).

### Unreleased — Local proxy security and provider onboarding

- Address the security findings in [issue #17](https://github.com/vahapogut/antigravity-add-model/issues/17): validate Host/Origin on desktop and IDE proxy routes while preserving native localhost calls; bind desktop model-list forwarding to the current owned language server; restrict authenticated non-image downloads to Google API HTTPS hosts without following redirects. Keep the IDE service isolated from desktop LS origins.
- Send credential-store diagnostics directly through the persisted logger using fixed messages without raw exceptions. Add an installer regression confirming that source maps and unrelated build files stay outside the addon. Add a [Spanish getting-started guide](README_es.md).
- Add the optional [Workers AI setup wizard](docs/workers-ai-setup.md) suggested in [issue #18](https://github.com/vahapogut/antigravity-add-model/issues/18): use an existing token or explicitly create an account-scoped expiring token, discover/select models, encrypt saved credentials and rotate only the chosen account's entries. Read-only verification checks catalog access; setup never runs generation or creates token managers.
- Improve [Google account-pool guidance](docs/configuration.md#google-cloud-code-account-pools) for [issue #19](https://github.com/vahapogut/antigravity-add-model/issues/19), distinguish access denial, rate limits and service unavailability without exposing provider error bodies, and make account tests use the saved model endpoint.

### Unreleased — Fallback configuration guide

- Address [issue #16](https://github.com/vahapogut/antigravity-add-model/issues/16) with [fallback-chain examples](docs/providers.md#fallback-chains-for-rate-limited-providers) for parallel agent workloads, dated Workers AI limits and the Unified billing requirement for the higher paid-model limit.
- Explain saved-name references, one-level chains, retry budgets, tool compatibility and the MCP delegation exception. Clarify that ordered failover does not guarantee combined throughput; no runtime behavior changed.

### Unreleased — IDE MCP delegation and native routing recovery

- Restore native Cloud Code routing after proxy restart, bearer refresh or cache expiry by looking up the same account's tier before forwarding generation. Preserve production/daily endpoint selection without retrying generation against another endpoint. Bound discovery time, response size and concurrent cache state; propagate cancellation and explicit discovery failures.
- Add `list_custom_models` and `delegate_to_model` through an authenticated local MCP server. IDE parents can send isolated text tasks to enabled saved custom models with exact selection, paginated discovery, bounded concurrency and cancellation. This is a text-only worker: it does not add the standalone runtime's native `invoke_subagent` tool, child UI, file access or terminal tools to the IDE.
- Add `npm run ide:mcp -- apply/status/restore` with comment-preserving edits, integrity-checked backups and conflict-safe recovery, including the IDE's comment-only starter configuration. Document installation, the verified global config location and [live validation limits](docs/ide.md#validation-boundary).
- Verify the complete flow in Windows IDE 2.5.5: the real Google Gemini 3.8 Flash High parent called both MCP tools after user approval, delegated to a local deterministic custom provider, and displayed its unique verification marker in the final reply. This validates text-only MCP delegation, not native child-agent UI or a paid custom provider.
- Also verify real remote delegation through OpenRouter's `nvidia/nemotron-3.5-lightning:free` endpoint: one successful HTTPS generation, matching response hashes through MCP and the final Gemini reply, and the expected arithmetic result displayed in the actual IDE. The model's input/output prices were zero at test time; provider credentials stay in encrypted local configuration.

### Unreleased — Custom model selection for subagents

- Extend custom subagent model selection to built-in Google/Cloud Code parents. Expose custom selectors in their tool schema, preserve wrapped responses, decode compressed JSON/SSE safely, and report routing errors without forwarding invalid tool calls. Add local HTTP coverage for first-child routing, stream framing and native response compatibility.
- Support enabled configured models in `invoke_subagent` alongside Antigravity's native model tiers. Resolve saved model names without ambiguous aliases or silent fallback from unknown/disabled selections; see [configuration](docs/configuration.md#subagent-model-selection).
- Isolate each spawn with a temporary route established from the child's prompt before the parent tool result arrives. Avoid collisions between parallel ID-less Google calls and restore original tool arguments before provider translation, including Google-to-OpenAI/Anthropic history replay.
- Keep routing state bounded and process-local, with explicit expired-route errors. Add local HTTP regressions for JSON/streaming responses, provider switches, concurrent children, and nested inheritance.

### Unreleased — Settings-surface injection for the Custom Models panel

- Mount the Custom Models panel only on real settings surfaces: the desktop Settings dialog (or `/settings` route) and the owned model-manager page, which now declares `data-testid="settings-view"`. Chat text such as an article or heading mentioning "MCP" or "Models & Usage" no longer attracts the panel.
- Require the mount to be visible settings content: headings inside hidden dialogs, `display: none` subtrees, navigation, articles and code blocks are ignored, and `findRefreshButton` only clicks the settings surface's own refresh button.
- Re-inject instead of leaking: a panel left in a stale parent (or moved into the conversation) is removed and remounted when the Settings dialog reappears; the mutation observer also watches `characterData` and visibility attributes so hiding/showing the dialog reliably adds or removes the panel.

### Unreleased — IDE adapter and direct-proxy diagnostics

- Add an Antigravity IDE settings adapter with recognized-layout preflight, comment-preserving edits, hash-checked backups, conflict-safe restore and managed launch. Recognize the official IDE 2.5.5 hidden core endpoint implementation and report its IDE version separately from VS Code 1.107.0. No vendor code or OS startup tasks are changed.
- Fix native IDE account setup by preserving valid HTTP framing for buffered proxy requests and selecting the production Cloud Code host before applying the account tier's upstream choice. Confirmed live Windows IDE 2.5.5 sign-in, native picker selection and streamed chat through a local OpenAI-compatible provider; see the [IDE validation results](docs/ide.md#validation-boundary).
- Replace colliding native placeholder hashes with a persistent identity registry shared by proxy and model-management transports. Preserve IDs across display-name edits and restarts, reserve native/deleted-model assignments, and report native slot exhaustion while keeping direct API aliases usable.
- Add an owned Node proxy service and authenticated loopback model manager using the same actions as the desktop UI. Service lifecycle verifies its own instance, refuses occupied ports and rejects cross-origin browser requests.
- Add bounded direct-request diagnostics with measured latency, provider token usage and recent models, plus an explicit short generation test. No prompts, response text or credentials are retained in diagnostic history.
- Add optional low/medium/high effort variants with copied encrypted credentials and recent-use ordering in the model manager. Variants of the same upstream model share its account cooldown.
- Add adaptive Google account selection, measured request/latency counters, fresh-quota eligibility and model-scoped cooldowns. Honor typed Google retry/reset details without inventing quota refill times.
- Refresh the [feature comparison](docs/feature-parity.md) against upstream v3.7.3, distinguishing verified source behavior from unavailable implementations and separate products.

### Unreleased — Vision model detection and image forwarding

- Fix [issue #11](https://github.com/vahapogut/antigravity-add-model/issues/11): recognize DeepSeek-VL/VL2, Janus/Janus-Pro and supported Flash model names without excluding an entire provider family. Preserve explicit image-support overrides and read native provider `input_modalities` metadata.
- Advertise image capabilities consistently across model-list response shapes and fallbacks. Forward actual image blocks to OpenAI-compatible and Anthropic-compatible endpoints instead of text placeholders, preserving multiple images, local binary files, public URLs and images alongside tool results.
- Keep image files out of the proxy's UTF-8 text-file resolver. Estimate image context separately from base64 text size, and reject invalid image input without retries or fallback requests. Add translator, discovery, model-list and full desktop HTTP regressions; see [image input setup](docs/configuration.md#image-inputs).

### Unreleased — Complete streamed tool calls

- Adapt the fix discussed in [PR #8](https://github.com/vahapogut/antigravity-add-model/pull/8): validate OpenAI tool arguments with the terminal event's final fragments before emitting any function calls. Valid single and parallel calls complete correctly, while malformed terminal-only calls are rejected without retrying or switching providers.
- Use Gemini's `STOP` finish reason for completed OpenAI-compatible and Anthropic tool calls. Preserve calls when reasoning arrives in the terminal event, and wait for completion before emitting buffered DSML calls.
- Flush pending text and validated calls when an OpenAI-compatible endpoint ends with `[DONE]` without a separate finish event. Add HTTP and translator regressions for fragmented arguments, mixed existing/new calls, invalid arguments, terminal reasoning, and DSML calls split across events.

### Unreleased — Cloudflare Workers AI and tool-schema bounds

- Add a Cloudflare Workers AI preset to the desktop and optional gateway, with account-specific endpoints, API token configuration, and model discovery through Cloudflare's paginated model search API.
- Fix string-encoded integer constraints such as `minLength: "1"` in tool declarations, reported in [issue #10](https://github.com/vahapogut/antigravity-add-model/issues/10). Normalize schema nodes across OpenAI-compatible, Anthropic, and gateway requests while preserving literal data and the original declarations.
- Add bounded, privacy-preserving desktop HTTP 400/422 schema diagnostics and regressions for JSON/streaming function calls. See [Workers AI setup](docs/providers.md#cloudflare-workers-ai) for account configuration and verification limits.

### Unreleased — Tool failure feedback

- Preserve explanatory text beside tool results when converting conversation history for OpenAI-compatible and Anthropic providers. An empty tool result no longer hides an error sent in a sibling text part.
- Keep tool replies grouped before accompanying feedback and preserve OpenAI assistant text beside tool calls. HTTP regressions verify that a later model request receives the failure and can correct the call.
- Apply the same feedback preservation to the optional gateway and retain declared JSON-schema constraints, including `parametersJsonSchema`, when forwarding its tools to providers.

### Unreleased — File-tool parameter preservation

- Fix a proxy bug matching [issue #7](https://github.com/vahapogut/antigravity-add-model/issues/7): valid file-writing calls could acquire an undeclared `AbsolutePath` argument and be rejected repeatedly.
- Preserve unknown/custom tool arguments, prefer each request's declared schema over historical parameter names, and resolve only explicit aliases without guessing paths from file content or descriptions.
- Apply the fix to OpenAI-compatible and Anthropic JSON/streaming responses, retain `parametersJsonSchema` declarations, and keep schema state isolated between concurrent requests.

### Unreleased — More providers and searchable catalogs

- Add desktop and gateway presets for Together AI, Hugging Face Inference Providers, SambaNova, SiliconFlow, Novita AI, and Alibaba Cloud Model Studio.
- Add gateway routing for DeepSeek, Mistral, xAI, Cerebras, and Fireworks AI, with provider settings and selectors generated from one gateway catalog.
- Add model-catalog search, filtered bulk selection, and import of available context/output limits and image/reasoning metadata without replacing explicit overrides.
- Handle provider-specific model listing, including Together's array response and paginated DashScope and Fireworks catalogs; filter unsupported model types and preserve exact model IDs.
- Document [provider endpoints and setup](docs/providers.md). Model availability, billing, and tool capabilities remain provider- and account-dependent.

### Unreleased — Model management and optional gateway

- Add grouped model editing, duplication, enable/disable, provider/local discovery, JSON/base64 import, and credential-redacted export.
- Add explicit protocols, request overrides, fallback chains, circuit breakers, and aggregate diagnostics.
- Add opt-in Google account sign-in with a user-owned OAuth client, encrypted account storage, token refresh, pool selection, and explicit quota checks.
- Add a separate authenticated gateway with provider-priority routing, web dashboard, SQLite history, replay, pricing estimates, and optional context compaction.
- Add saved remote gateway connections, authenticated alias import, and a read-only Doctor command while retaining vendor runtime hooks and transactional deployment.
- See [feature parity and boundaries](docs/feature-parity.md) for pinned source comparisons and verification limits.

### Unreleased — Antigravity 2.17.0 compatibility
- Reproduced the Windows black screen as `ERR_CERT_AUTHORITY_INVALID` with the old runtime overlay.
- Preserve the installed vendor runtime, including its certificate handling, WSL bridge, updater, and host bridge; add custom-model support through validated hooks.
- Recover recorded overlay installations from verified originals and reject unfamiliar runtime layouts before changing application files.
- Verified local UI startup with the official Windows 2.17.0 executable and language server in an isolated test profile. Authenticated model generation was not tested.

### v2.1.1
- **Critical Fix**: Fixed a startup crash (`a.getState is not a function`) when launching with Antigravity v2.12.2.
- **Architecture**: Removed a hardcoded 500ms page reload during startup that interrupted the Antigravity frontend's state hydration.
- **Compatibility**: Injected missing ContextBridge APIs (`getState`, `showOpenMultipleFolderDialog`, `revealInFilePicker`, `ideAPI`) into `preload.ts` that were introduced in Antigravity v2.12 and are required by the newer frontend renderer.

### v2.1.0
- **TypeScript**: Full migration — all 23 source files converted from JavaScript to TypeScript (`dist/*.js` → `src/*.ts`)
- **New Provider**: OpenRouter support (300+ models via unified API, OpenAI-compatible format)
- **OpenRouter UI**: Provider dropdown, auto-filled URL, connection test, icon & color in Settings modal
- **Dev Experience**: ESLint + Prettier configured with automated `lint`, `format`, `lint:fix` scripts
- **Test Coverage**: Expanded to 137 tests across 6 test files (registry, proxy, modelUtils, translators)
- **Cleanup**: Removed 25+ scratch development artifacts, added `.prettierignore`
- **Architecture**: `ideInstall/` wizard extracted to dedicated TypeScript module

### v2.0.3
- **Architecture**: Extracted Google AI Studio translator to dedicated module
- **Architecture**: Managed proxy state cleanup with proper interval lifecycle
- **New**: Model connectivity test in Settings (green/red status indicator)
- **New**: Automatic request retry with exponential backoff (429/5xx)
- **New**: Configurable `maxRetries` per model
- **Security**: Removed automatic SSL bypass for custom providers
- **Security**: Added 10MB request body size limit (413 on overflow)
- **Security**: Masked CSRF token in console output
- **Security**: Added timeouts to all Google proxy requests (30-60s)
- **Error handling**: Added debug logging to 6 previously-silent catch blocks
- **Error handling**: Proper error propagation in streaming response handlers
- **Fixed**: `deploy.ps1` now uses `$PSScriptRoot` (portable, no hardcoded paths)
- **Documentation**: Updated README with TypeScript architecture, security defaults, troubleshooting
- **Package**: Added `Apache-2.0` license field to `package.json`

### v2.0.2
- **Security**: Replaced `eval()` with safe `repairPartialJson()` (code injection fix)
- **Security**: SSL bypass now only when `allowUnauthorized: true` (not all custom providers)
- **Security**: Removed diagnostic `api_response_raw.json` disk writes
- **Security**: Added 10MB request body size limit
- **Security**: Added 120s configurable API request timeout
- **Error handling**: Added error handlers for streaming and non-streaming API responses
- **Fixed**: `deploy.ps1` hardcoded path to now uses `$PSScriptRoot`
- **Documentation**: Added Security Considerations, Troubleshooting, and Developer Guide

### v2.0.2 (2026-05-24)
- **Critical fix**: Antigravity v2.0.6 update hardcoded `fetchAvailableModels` URL to `daily-cloudcode-pa.googleapis.com`, bypassing the local proxy. Custom models disappeared from the chat dropdown.
- **Binary patch**: The Language Server binary is now automatically patched at build time to replace the hardcoded Google URL with the local proxy URL.
- **URL padding handler**: Added regex-based URL cleanup in the proxy to strip binary patch padding.
- **Model API fallbacks**: Added `GetAvailableModels` redirect, preload network interceptors, and forced page reload for robust model loading across Antigravity versions.

### v2.0.0
- Initial release: multi-provider proxy, API key encryption, streaming, tool calls, custom UI
