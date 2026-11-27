// Synthetic fixtures for the shared-defaults startup layout inspected in
// Windows standalone 2.35.2; no installed application files are included.
export const sharedLsDefaults = `
exports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;
exports.baseLsArgs = baseLsArgs;
exports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';
exports.LS_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
function baseLsArgs(opts) {
  return [
    '--standalone', '--override_ide_version', opts.ideVersion,
    '--https_server_port', String(opts.httpsServerPort),
    ...(opts.csrfToken !== undefined ? ['--csrf_token', opts.csrfToken] : []),
    '--app_data_dir', opts.appDataDir,
    '--api_server_url', exports.LS_API_SERVER_URL,
    '--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT,
  ];
}
`;

export const sharedLsServer = `
const lsDefaults_1 = require('./lsDefaults');
exports.startLanguageServer = startLanguageServer;
async function startLanguageServer(port, csrf, options = {}) {
  const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;
  const loginShellEnv = await Promise.resolve({ VENDOR_ENV: 'preserved' });
  return new Promise((resolve) => {
    record('vendor-start');
    const args = [
      ...(0, lsDefaults_1.baseLsArgs)({ ideVersion: '2.35.2', httpsServerPort: port, appDataDir: 'vendor-data' }),
      '--enable_sidecars',
    ];
    if (hostBridgeUrl && hostBridgeToken) args.push('--host_bridge_url=' + hostBridgeUrl, '--read_host_bridge_token_from_stdin');
    if (headless) args.push('--headless');
    if (wsl) args.push('--exit_on_stdin_close');
    const env = { ...loginShellEnv, ANTIGRAVITY_SERVER_CSRF_TOKEN: csrf };
    resolve({ args, wsl, env, stdin: hostBridgeToken });
  });
}
`;
