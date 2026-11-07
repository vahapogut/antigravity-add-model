import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { diagnose, languageServerEndpointCheck } from '../../scripts/doctor.mjs';

const directories: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^agy-doctor-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
async function fixture(contents?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doctor-'));
  directories.push(directory);
  const models = path.join(directory, 'models.json');
  if (contents) fs.writeFileSync(models, contents);
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"ok"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { directory, models, proxyUrl: url, gatewayUrl: url };
}
describe('native model picker endpoint diagnostics', () => {
  it('warns when a recognized language server still targets the remote catalogue', () => {
    const check = languageServerEndpointCheck('dynamic');
    expect(check).toEqual(expect.objectContaining({ name: 'native model picker', status: 'warning' }));
    expect(check?.message).toContain('--patch-language-server');
    expect(check?.message).toContain('50999');
  });

  it('confirms the fixed local endpoint and ignores unknown binaries', () => {
    expect(languageServerEndpointCheck('fixed')).toEqual({
      name: 'native model picker',
      status: 'ok',
      message: 'The language-server endpoint is configured to use the local proxy on port 50999.',
    });
    expect(languageServerEndpointCheck('unknown')).toBeNull();
  });
});

describe('read-only diagnostics', () => {
  it('reports absent build files and preserves malformed model files', async () => {
    const f = await fixture('{broken');
    const before = fs.readFileSync(f.models, 'utf8');
    const report = await diagnose({ ...f, dist: path.join(f.directory, 'absent-build') });
    expect(report.healthy).toBe(false);
    expect(report.checks.find((check) => check.name === 'build').status).toBe('error');
    expect(fs.readFileSync(f.models, 'utf8')).toBe(before);
  });
  it('validates configuration and warns about missing fallbacks without exposing credentials', async () => {
    const f = await fixture(
      JSON.stringify({
        models: [
          {
            name: 'models/test',
            provider: 'openai',
            externalModelName: 'test',
            apiUrl: 'http://localhost:1234/v1',
            apiKey: 'private-test-key',
            fallbackModels: ['models/missing'],
          },
        ],
      }),
    );
    const before = fs.readFileSync(f.models, 'utf8');
    const report = await diagnose(f);
    expect(report.healthy).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'model 1 fallback', status: 'warning' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'gateway', status: 'ok' }));
    expect(JSON.stringify(report)).not.toContain('private-test-key');
    expect(fs.readFileSync(f.models, 'utf8')).toBe(before);
  });
});
