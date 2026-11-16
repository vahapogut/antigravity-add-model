import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureIde,
  inspectIde,
  registerDynamicIdeRelease,
  HUB_ENDPOINT_RELEASES,
} from '../../scripts/ide.mjs';

const HUB_CLOUD_CODE_MARKER = 'agyCloudCodeUrl';

/**
 * Candidate directories where Antigravity IDE may be installed across platforms.
 */
export function getCandidateProductPaths(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();

  if (options.resources) {
    const resolved = path.resolve(options.resources);
    return [
      path.join(resolved, 'app', 'product.json'),
      path.join(resolved, 'resources', 'app', 'product.json'),
    ];
  }

  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots =
    platform === 'win32'
      ? [
          path.join(localAppData, 'Programs', 'Antigravity IDE'),
          path.join(localAppData, 'Programs', 'Antigravity'),
        ]
      : platform === 'darwin'
        ? [
            '/Applications/Antigravity IDE.app/Contents/Resources',
            '/Applications/Antigravity.app/Contents/Resources',
            path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources'),
          ]
        : [
            '/opt/antigravity-ide',
            '/opt/antigravity',
            '/usr/share/antigravity',
            '/usr/lib/antigravity',
            path.join(home, '.local', 'share', 'antigravity-ide'),
          ];

  return roots.flatMap((root) => [
    path.join(root, 'resources', 'app', 'product.json'),
    path.join(root, 'app', 'product.json'),
  ]);
}

export class IdeAutoPatcher {
  constructor(options = {}) {
    this.options = options;
    this.logger = options.logger || console;
  }

  /**
   * Locates the installed Antigravity `product.json` and dynamically registers its `ideVersion` and `commit`.
   */
  detectInstalledIde(overrideOptions = {}) {
    const opts = { ...this.options, ...overrideOptions };
    const candidates = getCandidateProductPaths(opts);

    for (const productPath of candidates) {
      try {
        if (!fs.existsSync(productPath)) continue;
        const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
        const appDir = path.dirname(productPath);
        const resourcesDir = path.dirname(appDir);
        const pkgPath = path.join(appDir, 'package.json');
        const pkg = fs.existsSync(pkgPath)
          ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
          : {};
        const ideVersion =
          typeof product.ideVersion === 'string' ? product.ideVersion : undefined;
        const commit = typeof product.commit === 'string' ? product.commit : undefined;

        if (ideVersion && commit) {
          registerDynamicIdeRelease(ideVersion, commit);
        }

        const launcherPath = path.join(appDir, 'extensions', 'agy', 'vscode', 'extension.js');
        let launcherPatched = false;
        if (fs.existsSync(launcherPath)) {
          const launcherSource = fs.readFileSync(launcherPath, 'utf8');
          launcherPatched = launcherSource.includes(HUB_CLOUD_CODE_MARKER);
        }

        return {
          found: true,
          productPath,
          appDir,
          resourcesDir,
          ideVersion: ideVersion || 'unknown',
          version: String(pkg.version || product.version || 'unknown'),
          commit,
          nameShort: product.nameShort,
          launcherPath,
          launcherPatched,
          registeredInReleaseSet: commit ? HUB_ENDPOINT_RELEASES.has(commit) : false,
        };
      } catch {
        // Continue searching next candidate
      }
    }

    return { found: false };
  }

  /**
   * Verifies the Antigravity IDE installation on startup and automatically applies or repairs
   * the IDE setting & launcher hook if an Antigravity update overwrote it.
   */
  ensurePatched(overrideOptions = {}) {
    const opts = { ...this.options, ...overrideOptions };
    const port = Number(opts.port) || 50999;
    const detected = this.detectInstalledIde(opts);

    if (!detected.found) {
      return {
        ok: false,
        reason: 'IDE_NOT_FOUND',
        detected,
      };
    }

    try {
      const inspectResult = inspectIde({
        ...opts,
        resources: opts.resources || detected.resourcesDir,
      });
      const statusResult = configureIde({
        ...opts,
        resources: inspectResult.resources,
        action: 'status',
        port,
      });

      const needsApply =
        !statusResult.applied ||
        statusResult.status === 'unconfigured' ||
        statusResult.launcherUpdateNeeded ||
        !detected.launcherPatched;

      let applyResult = statusResult;
      if (needsApply && statusResult.status !== 'conflict') {
        applyResult = configureIde({
          ...opts,
          resources: inspectResult.resources,
          action: 'apply',
          port,
        });
      }

      const endpoint = applyResult.endpoint || `http://127.0.0.1:${port}`;
      const message = `[OmniNorm] Antigravity IDE v${detected.ideVersion} detected & verified — proxy endpoint active on ${endpoint}`;
      if (this.logger && typeof this.logger.info === 'function') {
        this.logger.info(message);
      }

      return {
        ok: true,
        ideVersion: detected.ideVersion,
        version: detected.version,
        commit: detected.commit,
        endpoint,
        applied: Boolean(applyResult.applied),
        status: applyResult.status,
        repaired: needsApply && Boolean(applyResult.applied),
        message,
      };
    } catch (error) {
      return {
        ok: false,
        ideVersion: detected.ideVersion,
        commit: detected.commit,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const defaultIdeAutoPatcher = new IdeAutoPatcher();

export function ensureIdePatched(options = {}) {
  return defaultIdeAutoPatcher.ensurePatched(options);
}
