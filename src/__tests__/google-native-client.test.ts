import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GOOGLE_NATIVE_SCOPES, resolveGoogleNativeClient } from '../googleNativeClient';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
const originalLstat = vi.mocked(fs.lstatSync).getMockImplementation()!;

const temporary: string[] = [];
const clientId = 'fixture-personal.apps.googleusercontent.com';
const clientSecret = 'GOCSPX-fixture-personal';
function directory(): string {
  // macOS exposes its temporary directory through /var -> /private/var; fixtures must be canonical.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'google-native-client-')));
  temporary.push(root);
  return root;
}
afterEach(() => {
  vi.mocked(fs.lstatSync).mockImplementation(originalLstat);
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(resources = directory()) {
  const app = path.join(resources, 'app');
  fs.mkdirSync(path.join(app, 'out'), { recursive: true });
  fs.mkdirSync(path.join(app, 'extensions/antigravity'), { recursive: true });
  const pkg = { name: 'Antigravity IDE', version: '1.107.0', author: { name: 'Google' }, main: './out/main.js' };
  const product = {
    nameShort: 'Antigravity IDE',
    applicationName: 'antigravity-ide',
    ideVersion: '2.5.5',
    commit: 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8',
  };
  const extension = { name: 'antigravity', publisher: 'google', main: './dist/extension.js' };
  const source =
    `var profile=q({"out-build/vs/platform/cloudCode/common/oauthClient.js"(){"use strict";` +
    `personal="${clientId}",personalSecret="${clientSecret}",enterprise="fixture-gcp.apps.googleusercontent.com",enterpriseSecret="GOCSPX-fixture-gcp",scopes=${JSON.stringify(GOOGLE_NATIVE_SCOPES)}}});` +
    'class Native { exchangeCodeForToken(code,redirect,gcp){const uri=this.getLocalhostRedirectUri()??"",id=gcp?enterprise:personal,secret=gcp?enterpriseSecret:personalSecret,client=new OAuth(id,secret,uri);}' +
    'getLoginUrl(gcp){const uri=this.getLocalhostRedirectUri()??"",state=uuid(),id=gcp?enterprise:personal,secret=gcp?enterpriseSecret:personalSecret,url=new OAuth(id,secret,uri).generateAuthUrl({access_type:"offline",scope:scopes,state:state,prompt:"consent"});return Promise.resolve(url)}' +
    'getLocalhostRedirectUri(){return this._port===null?null:`http://localhost:${this._port}/oauth-callback`}}';
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify(product));
  fs.writeFileSync(path.join(app, 'extensions/antigravity/package.json'), JSON.stringify(extension));
  fs.writeFileSync(path.join(app, 'out/main.js'), source);
  return { resources, app, source, pkg, product, extension };
}

describe('native Antigravity public OAuth profile', () => {
  it('reads the personal pair and exact vendor scopes without executing the bundle', () => {
    const install = fixture();
    fs.appendFileSync(path.join(install.app, 'out/main.js'), ';throw new Error("MUST_NOT_EXECUTE");');
    expect(resolveGoogleNativeClient({ resources: install.resources })).toEqual({
      clientId,
      clientSecret,
      scopes: [...GOOGLE_NATIVE_SCOPES],
    });
    expect(resolveGoogleNativeClient({ resources: install.app }).clientId).toBe(clientId);
  });

  it('supports explicit portable resources and the current Electron resources directory', () => {
    const install = fixture();
    expect(resolveGoogleNativeClient({ env: { ANTIGRAVITY_IDE_RESOURCES: install.resources } }).clientId).toBe(
      clientId,
    );
    expect(resolveGoogleNativeClient({ env: {}, runtimeResources: install.resources }).clientId).toBe(clientId);
  });

  it.each(['win32', 'darwin', 'linux'] as const)('discovers the %s user install layout', (platform) => {
    const home = directory();
    const resources =
      platform === 'win32'
        ? path.join(home, 'Local/Programs/Antigravity IDE/resources')
        : platform === 'darwin'
          ? path.join(home, 'Applications/Antigravity IDE.app/Contents/Resources')
          : path.join(home, '.local/share/antigravity-ide/resources');
    fixture(resources);
    // Only probe the temporary home so an Antigravity install on the host cannot win discovery.
    vi.mocked(fs.lstatSync).mockImplementation((filename) => {
      const candidate = String(filename);
      if (candidate !== home && !home.startsWith(candidate + path.sep) && !candidate.startsWith(home + path.sep)) {
        throw new Error('outside the test home');
      }
      return originalLstat(filename);
    });
    expect(
      resolveGoogleNativeClient({
        platform,
        home,
        env: { LOCALAPPDATA: path.join(home, 'Local') },
        runtimeResources: '',
      }).clientId,
    ).toBe(clientId);
  });

  it.each(['package', 'product', 'extension'])('rejects unrecognized %s metadata', (kind) => {
    const install = fixture();
    const filename =
      kind === 'package' ? 'package.json' : kind === 'product' ? 'product.json' : 'extensions/antigravity/package.json';
    const value =
      kind === 'package'
        ? { ...install.pkg, author: { name: 'Unknown' } }
        : kind === 'product'
          ? { ...install.product, ideVersion: '99.0.0' }
          : { ...install.extension, publisher: 'unknown' };
    fs.writeFileSync(path.join(install.app, filename), JSON.stringify(value));
    expect(() => resolveGoogleNativeClient({ resources: install.resources })).toThrow('supported Antigravity IDE');
  });

  it.each([
    [
      'changed personal selection',
      (source: string) => source.replaceAll('gcp?enterprise:personal', 'gcp?personal:enterprise'),
    ],
    [
      'changed scopes',
      (source: string) => source.replace('https://www.googleapis.com/auth/cclog', 'https://other.example/scope'),
    ],
    [
      'unknown module',
      (source: string) => source.replace('cloudCode/common/oauthClient.js', 'cloudCode/common/other.js'),
    ],
    ['duplicate module', (source: string) => source + source],
  ] as const)('fails closed for %s', (_name, transform) => {
    const install = fixture();
    fs.writeFileSync(path.join(install.app, 'out/main.js'), transform(install.source));
    expect(() => resolveGoogleNativeClient({ resources: install.resources })).toThrow('supported Antigravity IDE');
  });

  it('does not silently use another installation when an explicit override is invalid', () => {
    const valid = fixture();
    expect(() =>
      resolveGoogleNativeClient({
        resources: path.join(directory(), 'missing'),
        runtimeResources: valid.resources,
      }),
    ).toThrow('supported Antigravity IDE');
  });

  it('rejects oversized bundles before parsing and returns a fixed error', () => {
    const install = fixture();
    fs.truncateSync(path.join(install.app, 'out/main.js'), 64 * 1024 * 1024 + 1);
    let error: unknown;
    try {
      resolveGoogleNativeClient({ resources: install.resources });
    } catch (value) {
      error = value;
    }
    expect(String(error)).toContain('ANTIGRAVITY_IDE_RESOURCES');
    expect(String(error)).not.toContain(install.resources);
    expect(String(error)).not.toContain(clientSecret);
  });

  it('rejects linked install contents', () => {
    const install = fixture();
    const target = path.join(install.resources, 'real-app');
    fs.renameSync(install.app, target);
    fs.symlinkSync(target, install.app, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveGoogleNativeClient({ resources: install.resources })).toThrow('supported Antigravity IDE');
  });
});
