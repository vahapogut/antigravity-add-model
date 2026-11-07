# Verified Windows native model-picker bypass (Antigravity 2.0.6)

## Summary

On one Windows 10 machine running the **standalone Electron Antigravity desktop app 2.0.6**, the native model picker did not list the configured custom models even though the addon configuration and local proxy were healthy.

The decisive evidence was the Language Server request path:

- **Before the fix:** `language_server.exe` called Google's hard-coded `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` endpoint directly, bypassing the local proxy.
- **After the fix:** the request went to the fixed local endpoint on `localhost:50999`; the proxy logged and intercepted `POST /v1internal:fetchAvailableModels`. After restarting Antigravity, the configured custom models appeared in the native picker.

The binary patch and its automated deployment tests already exist in this repository. This report records a real-world reproduction and verification path; it does not claim to introduce a second implementation of that patch.

## Environment and evidence boundary

| Item | Observed value |
| --- | --- |
| Operating system | Windows 10 (reported environment; exact edition/build not captured) |
| Product | Standalone Electron Antigravity desktop app, version 2.0.6 |
| Language Server | `resources/bin/language_server.exe` |
| Model configuration | 3 saved models, 3 enabled, 0 invalid |
| Proxy health | Healthy |
| Optional gateway | Not reachable; it was not required for this local-picker fix |
| Node.js version | Not captured |
| Hardware / Windows build number | Not captured |

This was a manual verification on one installation. It is not a compatibility claim for every Antigravity release, Windows build, or the separate VS Code-based Antigravity IDE.

## Root cause

There were two request paths that initially appeared easy to conflate:

1. A native `GetAvailableModels` interception/redirection appeared in the desktop's main log.
2. The actual Language Server log still showed `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`.

The first signal was not sufficient: the picker continued to request the model catalogue through the Language Server's hard-coded URL. That direct HTTPS call bypassed the addon proxy, so valid saved custom models were absent from the native picker.

## Reproduction and fix

Run these steps from the repository checkout. Paths below are examples; use the actual Resources directory for the local installation.

### 1. Close the desktop app completely

Exit Antigravity and ensure its Language Server process has stopped before changing application files. If deployment reports `EBUSY` for `app.asar`, a process is still holding the file; close the app/Language Server and retry. Do not force the patch onto a running installation.

### 2. Run the read-only preflight

```powershell
node scripts/deploy.mjs --check --patch-language-server
```

Expected result: preflight passes without changing files and identifies the recognized Windows Language Server endpoint patch. The fixed endpoint requires local port **50999**.

### 3. Apply the recognized Windows endpoint patch

```powershell
node scripts/deploy.mjs --patch-language-server
```

Expected output includes `PATCH INSTALLED`, the standalone app version/resources path, and the location of the verified original backup. The installer uses a known endpoint signature and refuses unknown or absent binaries instead of guessing. Do not use the option with the VS Code-based IDE or an unrecognized executable.

### 4. Restart and verify the real request path

Reopen Antigravity and inspect the Language Server and desktop logs.

**Before patching**, the Language Server log showed the request going directly to:

```text
https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
```

**After patching**, it showed the local fixed endpoint, including the request suffix:

```text
http://localhost:50999/v1internal/xxxxxxx/v1internal:fetchAvailableModels
```

The proxy then logged:

```text
[Proxy] Request: POST /v1internal:fetchAvailableModels
[Proxy] Intercepting fetchAvailableModels request
```

After this route was confirmed and Antigravity was restarted, the configured custom models appeared in the native picker.

The `xxxxxxx` segment is part of the equal-length replacement string used by the binary patch; it is not a credential.

### 5. Run the general diagnostic

```powershell
npm run doctor -- --resources "C:\path\to\Antigravity\resources"
```

Use the actual path rather than the example above. On the verified installation, the runtime was recognized as version 2.0.6, the model file contained 3 enabled models with no invalid entries, and the proxy health check passed. The optional gateway check was informational because the gateway was not being used.

A healthy proxy response alone does **not** prove that the native picker is using it. Confirm the Language Server URL and the proxy interception log as described above.

## Troubleshooting

| Observation | Interpretation / next step |
| --- | --- |
| Custom models are configured but absent from the native picker | Check the Language Server request URL, not just the main log's `GetAvailableModels` messages. |
| Language Server still calls `daily-cloudcode-pa.googleapis.com` directly after restart | The endpoint patch is not active for the running installation, or the app was updated/replaced after patching. Re-run the read-only preflight and follow the supported deployment procedure. |
| `EBUSY` while replacing `app.asar` | Antigravity or a child process still holds the installation file. Close the app and Language Server, then retry. |
| Port `50999` is occupied | The binary-patched endpoint requires that fixed port. Resolve the conflicting listener; the patched binary cannot use a dynamically chosen port. |
| Provider returns `401`, `403`, or `404` after the picker issue is fixed | Investigate provider credentials, account/service eligibility, API URL, and model access separately. This is not proof that the catalogue-bypass patch failed. |
| Binary is unknown or missing | Stop. The installer intentionally refuses to guess at an unknown binary signature. |

The installer's backup/restore safeguards should be retained until the patched application has been verified. Use the repository's documented restore command if rollback is needed; restore refuses to overwrite a later application update.

## Related implementation and tests

- `scripts/deploy.mjs` — explicit `--patch-language-server` preflight and transactional deployment.
- `src/__tests__/deployment.test.ts` — verifies the endpoint replacement, fixed-port marker, restore behavior, and refusal of unknown/absent binaries.
- `src/proxy.ts` — intercepts `/v1internal:fetchAvailableModels`.
- [Optional Windows language-server endpoint patch](compatibility.md#optional-windows-language-server-endpoint-patch).
- [PR #32: diagnose Windows native picker catalogue bypass](https://github.com/vahapogut/antigravity-add-model/pull/32) — adds a read-only diagnostic for installations still using the dynamic endpoint path.

## Privacy and limits

The report omits local usernames, installation-specific paths, credentials, tokens, and machine identifiers. The exact Windows build number and Node.js version were not recorded. Verification covers the described Windows standalone 2.0.6 installation only; other versions and the IDE adapter need separate evidence.
