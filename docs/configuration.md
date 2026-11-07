# Model configuration

Use **Settings → Models & Usage → Custom Models** in the standalone desktop app.
Older versions call this page **Models**. The editor and Import action validate
configuration and encrypt credentials before saving.

## Model files and import

Desktop models live at `~/.gemini/antigravity/custom_models.json`. Import accepts
a `models` object, a model array, or provider groups with inherited defaults, as
JSON or base64-encoded JSON. Existing internal names are updated; new names are
added. Provider-group defaults become independent model entries after import.

This secret-free example targets a local OpenAI-compatible server. Replace
`YOUR_LOCAL_MODEL_ID` with an ID returned by **Discover local** or your server:

```json
{
  "models": [
    {
      "name": "models/local-example",
      "displayName": "Local example",
      "provider": "lmstudio",
      "apiFormat": "openai",
      "apiUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "",
      "externalModelName": "YOUR_LOCAL_MODEL_ID",
      "enabled": true,
      "contextWindow": 32768,
      "maxOutputTokens": 4096,
      "timeout": 120000,
      "maxRetries": 2
    }
  ]
}
```

Choose limits supported by your actual model. The example does not install a
server or download a model. A local server that requires authentication still
needs its own API key.

## Discover and select models

Select a provider, enter its key and endpoint, then choose **Fetch provider models**.
Search the returned catalog by model name or ID. **Select filtered** selects the
current matches; selections remain checked when you change the search. **Add
selected** saves all checked models, including selections outside the current filter.

When available, discovery imports each model's context/output limits and image
and reasoning metadata. Explicit values in **Advanced settings** take priority.
An output limit at least as large as the context is reduced to leave input room.
Missing metadata keeps the normal defaults; review limits and capabilities for
your chosen model. Discovery does not generate a completion or verify tool use.
See [providers and model catalogs](providers.md) for endpoints and service-specific details.

## Native context estimate

On recognized native chat layouts, a small read-only ring appears beside the
model selector. Hover or focus it for details. `~` means an estimate from the
identified conversation's local transcript; `?` means usage is unavailable,
including when the conversation cannot be identified or its transcript cannot
be read reliably. Unknown usage is not displayed as zero.

The estimate counts recorded text, reasoning and tool-call text since the latest
structured checkpoint, using a character-based approximation. Hidden prompts,
tool definitions and image token costs are excluded. Actual provider usage can
be higher; the ring is not a measured token percentage, remaining-credit display,
or guarantee that the next request will fit.

An explicitly configured `contextWindow` takes priority. If the limit is missing,
clicking the ring can retrieve the public `models.dev` catalog with bounded time
and response size. Matching happens locally; the catalog request does not include
conversation text, credentials or the selected model name. Missing or ambiguous
limits remain unknown. This lookup and the transcript reader never change model
configuration, rewrite transcripts or trigger a generation request.

## Image inputs

Choose a model and endpoint that actually support image understanding. Discovery
imports image capability metadata when the provider supplies it; otherwise the
addon recognizes known vision model names, including DeepSeek-VL/VL2 and
Janus/Janus-Pro. These open models require a compatible serving endpoint; their
names alone do not make them available on the hosted DeepSeek API. See the
[DeepSeek vision guide](https://api-docs.deepseek.com/guides/vision/) for currently
supported hosted models.

In the model editor, **Advanced settings → Image input → Supported** explicitly
enables image attachments. **Unsupported** disables them; **Auto detect** uses the
model's default detection. JSON/import users can set `supportsVision: true` or
`false`. Both values take priority over name detection. This setting cannot add
vision to a text-only upstream model.

The desktop proxy forwards PNG, JPEG, GIF and WebP images as native image blocks
for OpenAI-compatible and Anthropic-compatible endpoints. It preserves images in
user conversation history, including images beside tool results. Inline base64,
base64 data URLs and local `file://` images are sent as image data; HTTP(S) image
URLs are passed to the selected provider and must be publicly accessible. Private URLs requiring a
separate login must be supplied as inline image data or a local file instead.
Incoming Google credentials are not forwarded to image URLs. Unsupported image
formats and unreadable local images return a clear error instead of being sent
as text. These formats accept image input in user messages.

Desktop context trimming budgets an estimated 1024 tokens per image rather than
treating base64 bytes as text tokens. Actual image cost depends on the provider,
model and resolution; upstream image-size and context limits still apply.

## Fields and advanced settings

Most fields are exposed under **Advanced settings**. Fields marked JSON/import
are supported in configuration but do not have a separate editor control.

| Field | Meaning |
| --- | --- |
| `name` | Unique saved identifier, normally `models/<name>`; used by fallback references. |
| `displayName`, `description` | Display label and optional description. |
| `provider` | Preset ID from [providers.ts](../src/providers.ts), including `custom` and `google-cloudcode`. |
| `apiFormat` | `openai`, `anthropic`, or `google`; determines wire format independently of the preset name. Cloud Code requires `google`. |
| `apiUrl`, `externalModelName` | HTTP(S) endpoint and exact upstream model ID. Do not embed credentials in URLs. |
| `apiKey` | Provider key; empty for a local endpoint without authentication. Saved values are masked. |
| `enabled` | Defaults to enabled; disabled models stay saved but leave the custom picker and fallback chain. |
| `reasoningEffort` | Optional `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; sent for the OpenAI format when configured. Model support varies. |
| `compactionReasoningEffort` | Optional `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` for recognized IDE continuation summaries only. Omit to keep normal model settings. See [compaction effort](#compaction-effort). |
| `compactionThresholdPercent` | Optional integer `10`–`90` for the native IDE checkpoint threshold. Requires an explicit, accurate `contextWindow`; blank inherits IDE behavior. See [compaction threshold](#compaction-threshold). |
| `thinkingBudget` | Nonnegative token budget for supported Google/Anthropic requests. For Anthropic, `0` disables thinking; otherwise use at least `1024` and less than the output limit. |
| `maxOutputTokens`, `contextWindow` | Positive token limits. If both exist, output must be smaller than context. Limits cannot enlarge the upstream model's capacity. |
| `timeout` | Per-attempt timeout in milliseconds; default `120000`. |
| `idleTimeout`, `retryBudgetMs` | JSON/import: idle timeout (default `30000`) and overall retry/fallback time budget. Without an override, the latter is at least `120000` or the configured timeout, whichever is larger. |
| `maxRetries` | Integer `0`–`5`, default `3`. Time budgets can stop attempts earlier. |
| `fallbackModels` | Ordered array of up to 20 saved internal names. The editor accepts a comma-separated list. |
| `circuitBreaker` | `enabled`, `failureThreshold`, `cooldownMs`; default threshold `3`, cooldown `30000` ms. |
| `customHeaders` | Object of string header values. Reserved transport headers and line breaks are rejected. |
| `extraBody` | Additional JSON request fields; cannot replace model/messages/contents/system/tools/stream routing fields. Ordinary exported configuration, not secret storage. |
| `rawUrl` | Use the exact request URL instead of protocol path normalization. |
| `supportsVision`, `supportsThinking` | Advertised capability overrides. Thinking capability is JSON/import; these flags do not add upstream capabilities. |
| `allowUnauthorized` | Disable certificate verification for this model only; leave false for normal endpoints. |
| `gateway` | JSON/import: marks an imported gateway route and forwards conversation identity for gateway sessions. Set automatically by **Import model aliases**. |
| `googleAccounts`, `googleProject`, `googlePool` | Cloud Code accounts, optional default project, and account-selection settings; see below. |

Timeout/budget fields accept `1`–`3600000` milliseconds. Context limiting uses a
rough token estimate and removes whole oldest turns while preserving
supported tool exchanges. The proxy refuses a latest turn that still cannot fit.
Retries and fallback stop after output starts; they do not duplicate an already
streamed answer. Renaming/deleting a model updates its saved fallback references.
For parallel workloads, see [fallback chains for rate-limited providers](providers.md#fallback-chains-for-rate-limited-providers)
for worked examples, retry timing and the separate MCP delegation behavior.

Old DeepSeek, Kimi, Fireworks, LM Studio, and llama.cpp entries without
`apiFormat` retain their historical Anthropic format. Select the intended format
explicitly when migrating a configuration.

## Compaction threshold

In **Advanced settings → Compaction threshold (%)**, set when the native IDE
should consider summarizing new context. Leaving it blank preserves the IDE's
default. Start at **50%** when many tools are enabled, then check context usage
before raising it. For example, a local server actually configured for an
85,000-token context and an 8,192-token output limit can use:

```json
{
  "contextWindow": 85000,
  "maxOutputTokens": 8192,
  "compactionThresholdPercent": 50
}
```

IDE 2.5.5 normally reserves at least 40,000 tokens for checkpoint processing;
an 85,000-token model therefore gets a default input cap of 45,000. This is
below its 50,000-token trigger, so initial checkpoint validation can fail.
The override keeps the real model capacity and reserves the configured output
limit plus 1,024 tokens instead. In the example, the checkpoint threshold is
**42,500 new tokens** and its input cap is **75,784**. The editor rejects an
unusable threshold and configurations that cannot safely pass the IDE's initial
50,000-token checkpoint budget.

IDE 2.5.5 validates its defaults before reading per-model overrides. For this
85k example, those defaults are invalid (50,000 trigger / 45,000 input cap).
When this explicit threshold setting is enabled, the native catalog therefore
uses a **90,000-token compatibility value** to pass that startup validation.
Saved configuration, provider requests and the checkpoint calculation still
use the real **85,000-token** limit. The IDE may display the larger compatibility
value; it is not extra provider capacity. This bridge is enabled only when the
real context minus output and 1,024 tokens leaves at least 50,000 tokens, so the
temporary native defaults also fit. Smaller budgets need an upstream IDE fix
and are rejected for this option instead of silently overstating their capacity.

The threshold applies to the IDE's count of new tokens since its previous
checkpoint, checked between steps. Its count includes native conversation
components and can differ from your provider's total context display. Large
single responses can cross the threshold before the next check. Fixed system
instructions and tool definitions also consume the input cap without counting
toward this new-token trigger in the same way. A high percentage can therefore
make the IDE trim older history **before a full checkpoint is created**. Lower
the percentage if this happens; even 50% is a starting point, not a guarantee
for every tool set or conversation.

For an advanced comparison, **80%** with the same 85,000 context and 8,192 output
limit targets 68,000 new tokens while retaining the 75,784 input cap. With a
16,384 output limit, both values are capped at 67,592. Use higher percentages
only after checking the remaining room for system instructions, tools and the
next response. This setting does not promise an exact provider counter value,
increase a model's capacity, or change the gateway's separate compaction settings.

Set **Compaction reasoning effort** separately if you also want the custom model
to create native summaries. A threshold alone keeps the IDE's existing summary
model choice. Restart the IDE and let the model catalog refresh after changing
either setting; its native experiment cache can update after the first turn.
Support is verified against IDE 2.5.5; other versions may handle these settings
differently.

Live Windows IDE 2.5.5 verification on **2026-10-15** used the 85k/8192/50%
configuration with a local deterministic OpenAI-compatible provider. The IDE
accepted the configuration, created a successful custom-model summary before
history trimming, and later used that summary in a normal response. Native
state confirmed a 42,500 new-token trigger and 75,784 input cap; the summary used
`low` effort and ordinary requests used `xhigh`. The conversation was created
in the UI and continued through ordinary native RPC messages with its resolved
configuration unchanged; no summary prompt or checkpoint override was injected.
Responses were 18,000 characters each (about 6,000 tokens by the native estimate).
This verifies the native workflow, not Ollama's tokenizer or a remote provider's
billing. Fully quit and reopen the IDE after changing the percentage: reloading
only its language server retained the previous experiment setting during testing.

## Compaction effort

In the model editor, open **Advanced settings → Compaction reasoning effort**.
Choose **low** to reduce thinking during context summaries while keeping your
normal chat effort, such as **xhigh**. Choose **none** only when your model
supports disabling reasoning. **Use normal model settings** is the default and
removes the override. JSON/import users can add these fields to a saved model:

```json
{
  "reasoningEffort": "xhigh",
  "compactionReasoningEffort": "low"
}
```

The desktop/IDE proxy recognizes both continuation-summary templates from the
verified Antigravity IDE **2.5.5** language server, including the session-summary
template captured during a live automatic checkpoint, in the final user turn. Earlier
history, tool results, quoted examples and ordinary requests to summarize a
document keep their normal settings. Other IDE versions or summary templates
may not match. The override is request-local and follows retries/fallbacks;
it does not rewrite the saved chat settings or enable compaction itself.
For IDE 2.5.5, explicitly choosing a compaction effort also advertises a
per-model native checkpoint setting so summaries use that custom model.
Leaving the setting inherited preserves the IDE's default summary-model choice.
Built-in model entries and other custom models are unchanged. Restart the IDE
after changing this setting and allow its model catalog to refresh; the native
experiment cache updates asynchronously, so the very first turn can still use
the previous checkpoint setting.
Imported gateway routes carry this explicit choice to the gateway, which applies
it after resolving the provider and avoids starting a second summary of that
summary request. Update both components when using this route.

OpenAI-compatible requests use `reasoning_effort`; OpenRouter uses its unified
`reasoning` object. Anthropic uses a thinking budget (1024 tokens for low/minimal)
or `thinking: {"type": "disabled"}` for none. Enabled Anthropic thinking needs
an output limit above 1024. Google 2.5 uses token budgets; Google 3+ uses thinking
levels. Always-on models cannot guarantee no reasoning: Gemini 2.5 Pro keeps
its 128-token minimum, and Gemini 3+ uses a supported minimal/low level for none.
Supported levels vary by model; an unsupported upstream option may still be
rejected. See the [Google thinking reference](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
and [Anthropic thinking reference](https://platform.claude.com/docs/en/build-with-claude/thinking).

The optional gateway has its own **Auto Context Compaction → Compaction Reasoning
Effort** setting for the extra summary requests it creates. Configure that
separately in the [gateway dashboard](../gateway/README.md#compaction-reasoning-effort).

Live Windows IDE 2.5.5 validation on **2026-10-14** confirmed automatic
checkpoint generation with a local OpenAI-compatible provider: ordinary requests
used `xhigh`, the native session summary used `low`, and the next ordinary
request returned to `xhigh`. The IDE stored the summary without fallback and
displayed a verification marker that existed only in that summary. The final
acceptance conversation was created and continued through the IDE UI, without
injecting a summary prompt or overriding its session configuration through RPC.
This verifies native routing and request settings; the local provider does not
measure a remote model's reasoning-token savings or latency.

## Subagent model selection

When Antigravity exposes the `invoke_subagent` tool, a conversation using either
a built-in or custom model can choose an enabled configured model through
`Subagents[].Model`. Use the model's exact saved `name`, such as
`models/local-example` from the import above;
the display label and upstream provider model ID are not interchangeable with
this name. Configure and enable the target model first, then include its saved
name when asking the agent to delegate work.

The native values `inherit`, `flash_lite`, `flash`, and `pro` remain available.
`inherit` (also the default when omitted) follows the calling agent's model,
including a custom model selected for that subagent. Explicit native tiers keep
Antigravity's own tier selection. Unknown, ambiguous, or disabled custom model
selections produce an error instead of silently choosing another model.

The proxy gives each custom-model spawn its own temporary routing marker. The
child's first request can select its model before the parent receives the tool
result, and parallel calls do not share a fallback tool-call ID. Markers are
removed before forwarding the child's prompt to a provider; replayed parent
history restores the original prompt and `Model` even after switching between
Gemini, OpenAI-compatible, and Anthropic-compatible providers.

Built-in Google/Cloud Code parents use the same routing bridge. The proxy exposes
custom model selection in their tool schema and rewrites their JSON or SSE tool
responses before Antigravity validates the native model tier. Cloud Code response
envelopes and compressed responses are handled without dropping their metadata.
An invalid selection returns an explicit error; if a stream has already started,
the proxy emits a terminal SSE error instead of forwarding an invalid tool call.

Routing state is held in proxy memory, with a one-hour inactivity limit and up
to 4,096 entries per routing cache. Start new subagents after restarting the
proxy or when a route has expired; a child using an unavailable marker reports
an error. Expired markers in parent tool history are removed so the parent can
continue and spawn fresh children; its original custom selection can only be
restored while the corresponding routing state remains available. Compaction
snapshots can also quote child prompts as JSON inside a user message. Route
markers in string `initialPrompt` fields of valid JSON objects are treated as
history and removed before active route detection, including after restart.
Markers outside those snapshot fields retain the normal routing checks. This feature
depends on Antigravity supplying the child prompt or a stable conversation
identity, and does not add native subagent tools to clients that do not expose
them. Automated routing coverage uses local HTTP fixtures. Actual Windows IDE
2.5.5 requests from both built-in Gemini and custom parents did not declare
`invoke_subagent`. Google lists native subagents for the separate Antigravity 2.0
app and CLI in its [subagent documentation](https://antigravity.google/docs/subagents/).

For the IDE, use the supported [MCP delegation setup](ide.md#delegate-to-custom-models-with-mcp).
The `delegate_to_model` tool sends an independent text task to an exact saved
custom model and returns its answer to the parent. This worker has no IDE tools,
filesystem access or inherited conversation; it does not open a native child
window. Native `invoke_subagent` routing remains available in clients that
actually expose that tool.

## Gateway routes

Configure **Remote gateway** with the gateway URL, token, and dashboard URL.
**Test gateway** checks authenticated model listing; **Import model aliases**
adds routes using `provider: "google"`, `apiFormat: "google"`, and `gateway: true`.
Imported routes retain advertised context/output limits and image/thinking
capabilities. The default imported context window is `128000`; unspecified
image/thinking capabilities default to false. Re-import to refresh alias metadata.

The saved connection is `~/.gemini/antigravity/gateway_connection.json`. Changing
the gateway origin requires entering its token again. See the [gateway guide](../gateway/README.md)
for setup, network listeners, tunnels, and the gateway's separate configuration.

## Google Cloud Code account pools

Choose **Google Cloud Code account pool** and enter an available model ID. Add
an account before using **Fetch provider models**; discovery uses an enabled
account. Add up to 50 accounts you own and choose how the pool selects them.
Pool sign-in creates a separate authorized session; it does not import or switch
the IDE's existing Google session.

1. Under **Sign in with Google**, leave **Sign-in method → Antigravity account** selected. The addon reads the personal-account OAuth client profile from a recognized local **Antigravity IDE 2.5.5** installation; you do not need to create a Google Cloud OAuth client for this option. For a portable installation, set `ANTIGRAVITY_IDE_RESOURCES` to its `resources` directory before starting the app or proxy service. Unknown versions or layouts produce an explicit error rather than selecting a different client.
2. Click **Sign in with Google** and complete browser consent. Both sign-in methods use [installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) with PKCE, state validation and a temporary loopback callback. Antigravity mode uses the recognized app's scope set; custom mode requests `cloud-platform`. Browser sign-in expires after two minutes and can be cancelled.
3. Antigravity sign-in then prepares the account's Cloud Code project and service endpoint. If first-time enrollment is needed, this explicit action can request the **free tier only**; Google still decides eligibility. It does not enroll in a paid tier. Wait for preparation to finish before saving.
4. Repeat for each account, then **Save model** within **10 minutes** of each successful sign-in. You can also fetch the catalog and **Add selected** to save several models with the same account. Saving one model no longer consumes the pending credentials needed by the remaining selections, and does not extend their original expiry. Pending credentials stay in main-process memory; the UI receives masked fields. Saved tokens and client secrets are encrypted. Sign in again if an unsaved entry expires.
5. Use **Test account** for access and quota, **Fetch provider models** for the catalog, and **Test generation** for a short model response. These check different things: successful login, project preparation or model listing does not establish successful generation. **Pool status** shows the current state; the fleet panel also refreshes quota as described below.

To keep using your own client, select **My Desktop OAuth client**, enter its
client ID and optional secret, and configure Google's **Desktop app** consent
and test users for your project. This option retains the existing custom-client
flow. You can also **Import account credentials** from your own `authorized_user`
JSON, account object or array. Import itself makes no network requests.

For an imported or previously saved account that needs project setup, click
**Prepare account**, then **Save model** to retain the returned project and
endpoint. If you edited an existing account's credentials or settings, save those
changes before preparing it. Preparation can perform the same free-tier
enrollment described above; ordinary listing and generation do not enroll accounts. Closing the
dialog cancels an ongoing sign-in or preparation. Preparation has its own
bounded timeout and reports an error if Google does not finish.

For saved accounts, a successful token refresh is encrypted and retained even
if the following preparation step fails or is cancelled. This preserves a newly
rotated refresh token; it does not mark failed preparation as successful or
overwrite concurrent account edits.

Each account has a unique stable `id`, optional `label`, `email`, `enabled`, `project`,
`clientId`, `clientSecret`, `refreshToken`, `accessToken`, and `expiresAt` (Unix
milliseconds). `authMode` records `antigravity` or `custom`; older entries without
it retain custom-client behavior. Preparation also records `cloudCodeEndpoint`,
restricted to the official production or daily Cloud Code origin, for subsequent
account tests, discovery and generation. These fields survive editing and saving.
Keep the ID unchanged when editing masked credentials. Account `project`
overrides `googleProject` when set.

`googlePool.strategy` accepts `round-robin`, `least-loaded`, `quota`, or `adaptive`.
Adaptive selection compares two eligible candidates using measured time to
response headers, in-flight load, recent failures and fresh known quota. Pool
status exposes request/success/failure counts and measured latency. Measurements
and quota snapshots become stale after ten minutes; unknown values remain unknown.
Remaining-quota selection uses the latest fresh retrieved snapshot. Conversation
affinity can retain an eligible account. `maxConcurrency` is per account
(`1`–`100`, default `2`); `cooldownMs` defaults to `60000` and accepts
`1`–`3600000`. Access tokens refresh as needed; failed authorization and
cooldown/concurrency state can temporarily make an account unavailable.

Structured Google `RetryInfo` / `ErrorInfo` hints and `Retry-After` take precedence
over the configured cooldown (bounded to 31 days). Cooldowns use the upstream
model ID, so local effort variants share the same limit. A cooldown does not
block a different upstream model using that account; authentication failures and
concurrency capacity remain account-wide. Quota eligibility stays scoped to the
account, OAuth client, project and endpoint that produced the measurement. A
snapshot with every fresh bucket explicitly at zero makes that scope unavailable;
one empty Claude bucket must not disable a positive Gemini bucket. No refill time
is guessed.

### Quota panel and preferred accounts

The Google account panel is available in desktop settings and the IDE's browser
model manager. Its collapsible account cards show a separate tile for every
assigned model pool, with its project, grouped quota buckets and relative reset
times; hover a reset time for the absolute date. Plan badges appear only when
Google reports the plan. Unknown quota and missing plans are not inferred from
bucket names, reset windows or other accounts.

A shared known email appears in one account card. Matching ignores case and
surrounding whitespace; memberships without a known email remain separate.
Every pool retains its own account ID, credentials, project, endpoint and quota
query. Even identically named buckets in different pools remain visible, so one
project's available quota cannot conceal another project's exhausted quota.
When Google returns both grouped and top-level buckets, distinct model families
and quota windows are retained.

While the fleet panel is mounted, it checks freshness every 30 seconds and reuses
each pool's result for up to two minutes. **Refresh quotas** forces new queries
and displays progress. Queries run sequentially through each owning model.
Refreshing does not generate a completion or purchase additional quota.

**Disable account** and **Enable account** affect the card's memberships while
preserving other accounts; a pool is disabled when no enabled account remains.
**Edit label** changes only labels across those memberships. Use a pool's editor
for its credentials and project. **Remove from fleet** asks for confirmation,
then detaches the account from its assigned pools without deleting model
definitions or other accounts. Per-pool **Remove** remains available.

**Use preferred** saves `googlePool.preferredAccountId` for that pool. The chosen
account is preferred only while enabled, authenticated and eligible for the
requested upstream model; quota, cooldown and concurrency limits still apply.
**Automatic** clears that preference and returns to the pool's selection strategy.
**Reconnect** stores the new OAuth credentials while retaining the account ID.
Account removal affects the selected pool, and other saved models remain intact.

The **Native Google request fallback** switch applies to all Google Cloud Code
pools; a mixed indicator means only some pools are enabled. To configure one
pool, set `googlePool.nativeFailoverEnabled` in its model editor. Enabling it lets native
Google generation retry through that saved pool after a confirmed quota/rate-limit
response. This is off by default. The saved `externalModelName` must match the
native request's model ID, and exactly one enabled opted-in pool must match.
Ambiguous configurations do not merge accounts or choose a pool arbitrarily.
Only Cloud Code requests and Cloud Code account pools participate; this switch
does not translate retries to the public Gemini API or another provider.
Retries use at most three eligible accounts and retain cancellation, deadlines,
scoped cooldowns and concurrency limits until the response completes. Permission
denials without a structured quota diagnosis do not trigger this behavior.

This does not sign the IDE into another Google account: it changes only which
explicitly authorized pool account handles the retry. The original IDE login
remains separate from the proxy's saved account pool.

The addon does not bundle the Antigravity OAuth client profile. It reads that
profile from the recognized installed app without executing vendor code or
extracting browser, IDE or gcloud account tokens. Consent remains explicit.
Successful OAuth or preparation does not guarantee model access or quota;
Google's location, eligibility and service-access decisions remain in effect.

### Installation support

Antigravity account sign-in currently recognizes the IDE **2.5.5** client module
and build signature. A missing or unsupported installation fails before browser
login; point `ANTIGRAVITY_IDE_RESOURCES` at the supported installation and restart,
or explicitly choose **My Desktop OAuth client**. This is a version-specific
adapter, not a promise that future vendor layouts will work unchanged. The
[IDE's own setup](ide.md#check-configure-and-launch) remains separate.

### Verified Google account flow

On **2026-10-14**, a real Google account completed browser OAuth using the
recognized official IDE **2.5.5** installation, followed by account/project
preparation. Catalog discovery returned **HTTP 200 with 19 models**, and the quota
request returned **HTTP 200**. A forced access-token expiry exercised a real
refresh through Google's OAuth token endpoint; updated expiry and encrypted
credentials were saved. A generation request to **`gemini-2.5-flash`** returned
**HTTP 200** with the requested `OK` response.

Cloud Code preparation, catalog, quota and generation requests now consistently
send this application's own `User-Agent`. This resolved the catalog **403**
observed during that test. It does not resolve every possible access denial;
use the guidance below for account or project permission failures.

This verifies the flow for one account on the recognized build, not universal
account eligibility or future IDE versions. Two-account switching after an
**HTTP 429** was verified with local fixtures, not with two live Google accounts.
Automated fixtures also cover OAuth callbacks, preparation, refresh and
cancellation. Use the separate checks above for your own account and model.

### Account access errors

| Result | Meaning and next step |
| --- | --- |
| **401** | Authorization was rejected. Reconnect the account using the same sign-in method. |
| **403** | Access was denied. Check the endpoint, account/project permissions, enabled services and eligibility. During OAuth, also check consent/test-user settings. A 403 alone does not prove an Enterprise subscription is required. |
| **429** | A rate or quota limit was reached. The pool respects the provider's retry/reset hints and can try another eligible configured account before output starts. |
| **503** | The provider is temporarily unavailable or overloaded. Retry later; another account may encounter the same provider-wide demand. This is not evidence of invalid credentials or exhausted personal quota. |

See [Google's error reference](https://ai.google.dev/gemini-api/docs/api-errors).
**Pool status** distinguishes access failures from transient cooldowns. Account
tests and discovery retain the HTTP status even if the provider returns an HTML
error page; provider error bodies are not echoed into diagnostics. If access
still fails, include the application version, selected provider, endpoint host/path
and the safe error message in an issue. Omit URL queries, account identifiers,
API keys, tokens, OAuth client secrets and authorization headers.

## Effort variants and recent models

Choose **Effort variants** on a saved model to review and create low/medium/high
copies. OpenAI-compatible models receive `reasoningEffort`; other formats also
receive thinking budgets of 1024/4096/8192 and sufficient output budgets. Confirm
your provider supports these values. The source model stays unchanged, name
collisions get numbered suffixes, and saved credentials are copied privately.
No provider request occurs when creating variants.

The model manager orders recently successful models first within its grouping.
This history is process-local and excludes generation tests. It does not change
native IDE picker ordering or the stored model identities.

## Direct-proxy diagnostics and generation tests

Open **Diagnostics** in the desktop addon or IDE browser manager to inspect up
to 200 recent requests, status, elapsed time and provider-reported input/output/
cached tokens. Missing usage is shown as unknown. Totals cover this bounded
in-memory window, not billing history; restarting or clearing diagnostics removes
it. Usage belongs to the final attempted model; earlier failed retry/fallback
attempts are excluded from token totals. Elapsed time covers the whole request.
Prompt text, response text, request URLs and credentials are not retained.

**Test generation (uses quota)** in the model editor sends the fixed prompt
`Reply with OK.` with a 1024-token output budget, a 30-second limit, no tools,
retries or fallback models. It exercises the same request translation as normal
chat and reports whether generated text was received. The budget leaves room for
reasoning models that think before answering; other models stop after replying.
A reply that contains only reasoning and no answer text still counts as a failure.
**Test connection** still checks the provider's catalog/authentication without
requesting generation.

## Credentials and data

Desktop API keys, custom-header values, saved gateway tokens, and Google
access/refresh tokens and client secrets are encrypted before persistence.
Electron `safeStorage` is preferred; otherwise AES-256-GCM uses a generated local
key at `~/.gemini/antigravity/.model-credentials-key`. Keep the key with private
backups. Machine-encrypted secrets are not portable configuration; enter fresh
credentials when moving to another machine or when decryption fails.

Saved secrets appear as `********`; leaving them unchanged preserves them on
the main-process side. Changing a provider or server origin requires fresh
credentials. **Export** removes API keys, all custom headers, and Google
access/refresh tokens and client secrets. It retains ordinary settings, account
labels/IDs, client IDs, and project names. Do not put secrets in `extraBody`, URLs,
descriptions, or other ordinary fields, and review exported metadata before sharing.

The optional gateway has a separate profile at `~/.gemini/antigravity/gateway`.
Its credential configuration does not use Electron `safeStorage`; its SQLite
history stores prompts, responses, tools, and replay snapshots. Consult
[gateway data handling](../gateway/README.md#lifecycle-and-data) before sharing
that profile. Desktop model Export does not export the gateway's database.
