# Compatibility and recovery

## Desktop agent and VS Code-based IDE are different applications

This patch targets the standalone Electron desktop agent: `Resources/app.asar`
with a `dist/main.js` entry point and `dist/preload.js`. The installer preserves
the installed application's runtime and adds custom-model modules under
`dist/modelPatch`. It validates three integration hooks before changing files:
desktop startup, language-server endpoint arguments, and the preload addon.
An unfamiliar runtime fails preflight with `UNSUPPORTED_RUNTIME`.

The separate Antigravity IDE uses an unpacked `Resources/app/out` tree (or an
archive with an `out/main.js` entry point), a VS Code workbench, and a different
language-server integration. Copying this project's `dist` directory into it
does not load the proxy or add a settings dashboard. The installer detects that
layout and exits with `NOT_SUPPORTED` before modifying application files.
Use the separate [IDE adapter](ide.md): it validates the IDE's declared
`jetski.cloudCodeUrl` setting or the verified 2.5.5 core implementation, backs up and changes user settings, and
launches an owned Node proxy before the IDE. It includes a local web model manager.
Windows IDE 2.5.5 was verified with real sign-in, native model selection and a
streamed chat response through a local OpenAI-compatible provider. This does not
establish GUI compatibility for other versions or platforms, including macOS
IDE 2.1.1 reported in [Issue #2](https://github.com/vahapogut/antigravity-add-model/issues/2).

| Installation | Current behavior |
| --- | --- |
| Standalone Electron `app.asar`, entry `dist/main.js` | Validated runtime hooks; vendor APIs, certificate handling, updater and window code are retained |
| Standalone Windows app connected to WSL | Vendor WSL behavior is retained; custom-model proxy routing applies only to local sessions |
| Unpacked IDE `app/out` with a declared endpoint setting, verified 2.5.5 core, or verified 2.6.0 hub launcher | Separate `ide:apply`/`ide:launch` adapter. Windows 2.5.5 live chat is verified. Windows 2.6.0 is recognized by commit `9e3a5da5…` and forwards the loopback proxy to the `agy` hub; restart the IDE after apply |
| Archived IDE with an `out/main.js` entry point | Unsupported; refused without changing the application |
| Missing or unrecognized application layout | Explicit error; no success message |

A matching layout and version number are not a guarantee of compatibility with
every future Antigravity release. CI uses controlled Electron mocks and synthetic
ASAR packages; it does not log in to Google. CI includes macOS for filesystem
behavior, not proof of macOS IDE model generation, signing, or UI support.

## Black screen after an update

[Issue #1](https://github.com/vahapogut/antigravity-add-model/issues/1) reports
startup failures on newer desktop builds, including a recurrence in
[2.17.0](https://github.com/vahapogut/antigravity-add-model/issues/1#issuecomment-5874214374).
The old installer replaced the complete desktop runtime with this repository's
older copy. The official 2.17.0 package adds a `wsl` renderer bridge and changes
local language-server certificate handling. Replacing its preload/main/server
files loses those changes and can prevent the UI from starting. In an isolated
Windows test using the official 2.17.0 executable and language server, the old
overlay reproduced `ERR_CERT_AUTHORITY_INVALID` / main-frame load error `-202`;
both the pristine vendor runtime and the new additive patch loaded the local UI
successfully under the same conditions. The patched run started its proxy without
certificate, main-frame load, or preload errors. The test used an isolated profile,
blocked external traffic, and disabled update installation, protocol registration,
and external browser opening in its harness. It did not sign in to Google or
verify authenticated model listing/generation. The official Linux 2.17.0 archive
also passed runtime-hook validation; Linux/macOS GUI launches were not tested.

Deployment now retains the vendor preload (including every exposed bridge), IPC
handlers, WSL and host-bridge integration, certificate policy, updater, and window
settings. The custom UI is appended in its own scope without re-exposing vendor
globals; proxy startup and endpoint changes are inserted only at validated hooks.
The local proxy is bypassed in WSL sessions, where Windows loopback is not a
reliable route to the host from the Linux server. Custom-model generation in WSL
is not supported by this patch.

The earlier
[contribution #3](https://github.com/vahapogut/antigravity-add-model/pull/3), by
Beshoy-Sorial, identifies a missing `electronUpdater.getState()` call in 2.12.2.
Those legacy compatibility sources remain in the repository, but the installer
now uses the APIs shipped with the installed application instead of replacing them.

The model-response wrappers leave protocol-framed/non-JSON responses unchanged
and preserve XHR event ordering. These wrappers run in an Electron preload; they
are not evidence that the separate VS Code workbench is supported.

Older deploy scripts reused `app.asar.backup` indefinitely, even after an upstream
update. That could reinstall an old archive alongside newer external resources
and language-server binaries. Deployment now starts from the current archive,
preserves vendor files, builds and verifies a candidate before replacement,
and restores the previous files if a replacement fails. Legacy `.backup` and
`.bak` files are not automatically restored.

## Install, check, and restore

Use Node.js **22.12.0 or newer** (required by the pinned ASAR tool), then:

```sh
npm ci --ignore-scripts
npm run build
node scripts/deploy.mjs --check
```

Quit the standalone app and its language server before deployment. The installer
does not terminate processes, launch applications, or disable automatic updates.
All platform wrappers accept the same arguments:

```powershell
# Windows
.\deploy.ps1 --check --patch-language-server
.\deploy.ps1 --patch-language-server
```

```sh
# macOS standalone desktop agent
bash deploy.sh --check --resources "/Applications/Antigravity.app"
bash deploy.sh --resources "/Applications/Antigravity.app"

# Linux
bash deploy_linux.sh --check --resources /opt/antigravity/resources
bash deploy_linux.sh --resources /opt/antigravity/resources
```

`--resources` accepts a Resources directory, an installation root, or a macOS
`.app` directory. `--check` performs preflight only. Reopen the application
manually after a successful deployment.

The installer keeps version/fingerprint-specific restore data in
`Resources/.antigravity-model-patch`. To undo its last deployment:

```sh
node scripts/deploy.mjs --restore --resources "/path/to/Resources"
```

Restore refuses to overwrite application files that changed after deployment,
including an upstream update. It does not restore an arbitrary old release over
the new one. Keep the restore data until you have verified the patched app.
If a previous installer already mixed incompatible versions, reinstall a clean
vendor build first; this installer cannot infer which old backup was pristine.
When upgrading from the transactional overlay installer, a matching manifest and
SHA-256-verified original backup let this installer recover the correct vendor
runtime automatically. Repeat installation always starts from that same verified
original, so hooks do not accumulate. An old overlay without a valid restore point
requires a clean vendor reinstall; arbitrary `.backup` files are never guessed.

After an upstream update, run `--check` again and rebuild before redeploying.
Report a new failure with the desktop/IDE distinction, app version, OS, installer
output, and first application error. Do not include API keys or auth headers.

## Windows installer asks to close Antigravity

First identify the product: **Antigravity IDE** and the **standalone desktop
agent** use different installations. The IDE adapter changes its managed user
setting; the standalone addon changes verified application files. A request to
close the application alone does not prove that a modified file caused the
installer failure. See [issue #22](https://github.com/vahapogut/antigravity-add-model/issues/22).

Update this repository, install dependencies if needed, and inspect the exact
installation you intend to update:

```powershell
node scripts/update-preflight.mjs check --resources "C:\path\to\Antigravity\resources" --json
```

This read-only check verifies managed restore data and lists matching Windows
process IDs, names and executable paths. It also reports other Antigravity
installations and processes whose executable identity could not be checked.
For IDE installations, it reads the actual mutex name from vendor metadata and
checks the application, setup and update-readiness mutexes in the current
Windows session. This also detects a setup process running from a temporary
directory that would not appear in the application process list. The probe only
opens existing handles for inspection; it never creates or releases a mutex.
It does not inspect every Windows file lock or guarantee that an installer will
succeed. Close the application and its language server normally, and finish or
cancel any existing installer before preparing the same installation:

```powershell
node scripts/update-preflight.mjs prepare --resources "C:\path\to\Antigravity\resources"
```

The equivalent npm commands are `npm run update:check -- ...` and
`npm run update:prepare -- ...`. In PowerShell, use `npm.cmd` or the direct
`node` commands above if `npm.ps1` consumes the option separator.

For an IDE using a non-default profile, add `--settings "C:\path\to\User\settings.json"`
to both commands. If the owned proxy uses a custom data directory, also add
`--data-dir "C:\path\to\proxy-data"`. Use the same paths you supplied to `ide:apply`
and `ide:launch`; do not select a different profile just to bypass a conflict.

Preparation restores only verified managed changes, stops the authenticated
owned proxy, and preserves saved models and credentials. It refuses active or
unverifiable process/mutex blockers, changed installations and invalid backups.
It checks processes and mutexes again after backup verification, immediately
before restoration, so an application restarted during inspection is caught. It
does not kill processes, disable the updater, run the installer, or overwrite
a partially updated installation with an old archive. Automatic preparation
requires Windows process inspection and, for the IDE, mutex inspection; a failed
inspection leaves files alone.

Proxy shutdown drains connections for up to 1.5 seconds by default, then closes
unfinished client and upstream connections owned by the proxy. The legacy desktop runtime signals
its language server while the proxy drains, preventing an unfinished language
server request from holding quit open, and cancels startup if quit arrives before
the language server launches. If `proxy:stop` cannot authenticate the
service but its recorded process or run-lock process is still alive or cannot
be inspected, it now reports an error instead of claiming the service stopped.
After authenticated shutdown, it also waits for the recorded process to exit.
That error does not authorize killing an unrelated process or deleting its lock.

Run the official installer manually after successful preparation. Rebuild and
recheck compatibility before applying the addon to the new version. If the
installer still fails, report the product, current/target versions, installer
filename, installation method, diagnostic output and exact installer error/log.
Redact personal paths and credentials. The reporter's persistent failure after
a Windows restart has not been reproduced; the verified shutdown and diagnostic
fixes below do not establish that failure's cause.

Live Windows validation on **2026-10-15** used an isolated official IDE 2.5.5
profile. Inspection identified its running processes; after the IDE was closed,
preparation restored its managed endpoint setting and stopped the production
owned proxy. A follow-up used the signed official IDE 2.5.5 installer without
installing anything: with an isolated IDE process running, setup displayed the
close-application warning; after that test process exited, setup advanced to the
license screen. While only setup remained open, the previous preflight reported
ready with an empty application process list, but the new preflight detected the
setup mutex and refused preparation without changes. After canceling setup, all
three mutexes were absent and inspection passed. The updated preparation command
also restored the isolated IDE settings and stopped the production proxy with an
incomplete authenticated request open; saved model data was preserved and the
recorded proxy process had exited. This checks the installer gate and addon
recovery, not a complete version upgrade. Regression tests also cover unfinished TCP
requests, a process restarting during inspection, unresponsive service records,
standalone ASAR restoration, damaged backups, and unrelated listeners.

## Optional Windows language-server endpoint patch

Some standalone Windows builds bypass the configurable API server for model-list
requests. Their existing fixed-length endpoint replacement is available explicitly:

```powershell
.\deploy.ps1 --check --patch-language-server
.\deploy.ps1 --patch-language-server
```

This option is restricted to the recognized `resources/bin/language_server.exe`
endpoint and participates in backup/rollback. Unknown binary contents cause an
error instead of a guessed offset. It is not a macOS or IDE binary patch.
The modified binary requires port **50999**. An archive marker makes the proxy
fail clearly if that port is occupied instead of silently choosing a different
port that the binary cannot use. Normal unpatched operation retains dynamic-port
fallback. Language-server restarts reuse the existing proxy listener; concurrent
starts and shutdowns are coordinated so a restart does not collide with its own port.

## Provider 403/404 errors are a separate problem

The `UNSUPPORTED_LOCATION` response in issue #1 is a Google account/service
eligibility decision. Replacing a preload or repeatedly reinstalling the patch
does not change it. Check the provider's supported locations and account access.
A 404 needs the configured API URL and model/route availability checked.

The connection-test button requests the provider's model list with the saved
credentials and custom headers. It reports 401, 403, 404, 405, 429 and server
failures as unsuccessful, and checks whether the selected model is advertised.
An endpoint without a model-list API may still support generation; configure it
manually if necessary. A successful listing does not prove that model generation
will work or that the account has sufficient quota. For Google Cloud Code, the
account editor also offers an explicit authorization/quota check.

## Local proxy trust boundary

Both the desktop proxy and the IDE service bind to loopback and validate the
request's Host and browser Origin before routing. Native callers can use
`localhost:<proxy-port>` or `127.0.0.1:<proxy-port>` without an Origin header.
Browser callers must use the proxy's own local origin; the standalone desktop
also permits its registered, currently running language-server origin. Other
origins, including `null`, are rejected. The IDE service does not inherit the
desktop language-server exception. A port change invalidates the old LS origin.

Desktop `GetAvailableModels` forwarding accepts only the app's active local
language-server port and known model-list RPC paths. The self-signed TLS
exception is restricted to that target. The caller cannot choose another
remote service or a different local port through `?ls=`.

Incoming Google authorization is attached to non-image file downloads only for
HTTPS `googleapis.com` or its subdomains on the default HTTPS port. Redirects
are not followed. Image inputs keep their existing credential-free handling.

These checks protect the local service from foreign browser origins; they are
not authentication of every process on the same computer. Local native callers
remain trusted. IDE management and MCP endpoints additionally require the owned
service token. Use the [authenticated gateway](../gateway/README.md#remote-access)
for remote access rather than exposing the local proxy.

Credential-store diagnostics use `electron-log` directly, including in the
addon loaded by the preserved vendor runtime. Failures use fixed messages and
omit raw exceptions, tokens and ciphertext. The standalone installer copies
only the runtime JavaScript allowlist into the addon directory; repository
source maps and unrelated build files are not packaged into the addon.
