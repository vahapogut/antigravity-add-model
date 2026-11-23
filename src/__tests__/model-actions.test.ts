import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createModelManager } from '../modelManagement';
import { createModelActions } from '../modelActions';
import { allocateModelIdentities, NATIVE_MODEL_CAPACITY } from '../modelIdentity';
import type { ModelEntry } from '../modelStore';

const directories: string[] = [];
const codec = {
  encryptString: (value: string) => `test:${Buffer.from(value).toString('base64')}`,
  decryptString: (value: string) =>
    value.startsWith('test:') ? Buffer.from(value.slice(5), 'base64').toString() : value,
};
const example = {
  name: 'models/local-one',
  displayName: 'One',
  provider: 'openai',
  apiUrl: 'https://provider.example/v1',
  externalModelName: 'provider-model',
  apiKey: 'private-key-12345',
  customHeaders: { 'x-tenant': 'private-header-12345' },
};
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-actions-test-')));
  directories.push(directory);
  const manager = createModelManager(directory, codec, async () => {});
  const actions = createModelActions(manager);
  const list = () => actions['storage:get-custom-models']() as ModelEntry[];
  return { directory, manager, actions, list };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^agy-actions-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('shared management model identity responses', () => {
  it('returns the proxy identity for each saved model without exposing secrets or the registry', () => {
    const f = fixture();
    f.manager.saveModel(example);
    f.manager.saveModel({ ...example, name: 'models/local-two', displayName: 'Two' });
    const identities = allocateModelIdentities(f.directory, f.manager.store.read());
    const response = f.list();
    for (const model of response) {
      const identity = identities.find((entry) => entry.name === model.name)!;
      expect(model).toMatchObject({
        nativeCatalogId: identity.catalogId,
        nativeModelId: identity.placeholderId,
        nativePickerAvailable: true,
        apiKey: '********',
        customHeaders: { 'x-tenant': '********' },
      });
      expect(model).not.toHaveProperty('assignments');
      expect(model).not.toHaveProperty('reserved');
      expect(model.nativePickerError).toBeUndefined();
    }
    expect(new Set(response.map((model) => model.nativeModelId)).size).toBe(2);
    const metadata = fs.readFileSync(path.join(f.directory, 'custom_model_identities.json'), 'utf8');
    for (const secret of [example.apiKey, example.customHeaders['x-tenant']]) {
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(metadata).not.toContain(secret);
    }
  });

  it('keeps native identity after a displayed name edit and reconstructing the management transport', () => {
    const f = fixture();
    f.manager.saveModel(example);
    const original = f.list()[0];
    f.actions['storage:save-custom-model']({ ...original, displayName: 'A completely different label' });
    const reopened = createModelActions(createModelManager(f.directory, codec, async () => {}));
    const updated = reopened['storage:get-custom-models']() as ModelEntry[];
    expect(updated[0]).toMatchObject({
      displayName: 'A completely different label',
      nativeCatalogId: original.nativeCatalogId,
      nativeModelId: original.nativeModelId,
      nativePickerAvailable: true,
    });
  });

  it('returns computed checkpoint metadata to both managers without persisting it', () => {
    const f = fixture();
    f.manager.saveModel({
      ...example, contextWindow: 85000, maxOutputTokens: 8192,
      compactionReasoningEffort: 'low', compactionThresholdPercent: 80,
    });
    const [returned] = f.list();
    expect(returned).toMatchObject({ contextWindow: 85000, nativeContextWindow: 90000, nativeMaxOutputTokens: 8192 });
    const experiments = returned.nativeModelExperiments as { experiments: Record<string, { stringValue: string }> };
    expect(JSON.parse(experiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue)).toEqual({
      useLastPlannerModel: true, maxOutputTokens: 8192, tokenThreshold: 68000, maxTokenLimit: 75784,
    });
    f.actions['storage:save-custom-model'](returned);
    expect(f.manager.store.read()[0]).not.toHaveProperty('nativeModelExperiments');
    expect(f.manager.store.read()[0]).not.toHaveProperty('configIndex');
    expect(f.manager.store.read()[0]).toMatchObject({ compactionThresholdPercent: 80, contextWindow: 85000 });
    expect(f.list()[0].nativeModelExperiments).toEqual(experiments);
    f.actions['storage:save-custom-model']({ ...returned, compactionThresholdPercent: undefined, compactionReasoningEffort: undefined });
    expect(f.list()[0].nativeModelExperiments).toBeUndefined();
  });

  it('does not trust or persist identity fields supplied by save and import clients', () => {
    const f = fixture();
    const forged = {
      nativeCatalogId: 'native-victim',
      nativeModelId: 'MODEL_PLACEHOLDER_M99999',
      nativePickerAvailable: true,
      nativePickerError: 'forged error',
      nativeContextWindow: 999999999,
      nativeMaxOutputTokens: 1,
      nativeModelExperiments: { experiments: { attacker: { boolValue: true } } },
    };
    f.actions['storage:save-custom-model']({ ...example, ...forged });
    f.actions['storage:import-custom-models']({ models: [{ ...example, name: 'models/imported', ...forged }] });
    for (const saved of f.manager.store.read()) {
      expect(saved).not.toHaveProperty('nativeCatalogId');
      expect(saved).not.toHaveProperty('nativeModelId');
      expect(saved).not.toHaveProperty('nativePickerAvailable');
      expect(saved).not.toHaveProperty('nativePickerError');
      expect(saved).not.toHaveProperty('nativeContextWindow');
      expect(saved).not.toHaveProperty('nativeMaxOutputTokens');
      expect(saved).not.toHaveProperty('nativeModelExperiments');
    }
    for (const returned of f.list()) {
      expect(returned.nativeCatalogId).not.toBe(forged.nativeCatalogId);
      expect(returned.nativeModelId).not.toBe(forged.nativeModelId);
      expect(returned.nativeContextWindow).not.toBe(forged.nativeContextWindow);
      expect(returned.nativeMaxOutputTokens).not.toBe(forged.nativeMaxOutputTokens);
      expect(returned.nativeModelExperiments).toBeUndefined();
    }
  });

  it('keeps management available but disables native injection when the identity registry cannot be read', () => {
    const f = fixture();
    f.manager.saveModel(example);
    const filename = path.join(f.directory, 'custom_model_identities.json');
    fs.writeFileSync(filename, '{corrupted registry');
    expect(f.list()).toMatchObject([{ name: example.name, nativePickerAvailable: false, apiKey: '********' }]);
    expect(f.list()[0].nativeModelId).toBeUndefined();
    expect(f.list()[0].nativePickerError).toEqual(expect.any(String));
    expect(f.list()[0].nativePickerError).not.toContain('capacity reached');
    expect(fs.readFileSync(filename, 'utf8')).toBe('{corrupted registry');
  });

  it('reports capacity overflow explicitly while keeping all models editable with unique assigned IDs', () => {
    const f = fixture();
    f.manager.store.import({
      models: Array.from({ length: NATIVE_MODEL_CAPACITY + 1 }, (_, index) => ({
        ...example,
        name: `models/entry-${index}`,
        displayName: `Model ${index}`,
      })),
    });
    const response = f.list();
    expect(response).toHaveLength(NATIVE_MODEL_CAPACITY + 1);
    const available = response.filter((model) => model.nativePickerAvailable);
    expect(available).toHaveLength(NATIVE_MODEL_CAPACITY);
    expect(new Set(available.map((model) => model.nativeModelId)).size).toBe(NATIVE_MODEL_CAPACITY);
    expect(response.filter((model) => !model.nativePickerAvailable)).toMatchObject([{ nativeModelId: undefined }]);
    expect(response.find((model) => !model.nativePickerAvailable)?.nativePickerError).toContain('capacity reached');
  });
});
