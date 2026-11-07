import { describe, expect, it } from 'vitest';
import type { CustomModel } from '../proxy';
import { catalogModelSlug, localModelSlug } from '../proxy/modelCatalog';
import { resolveConfiguredSubagentModel } from '../proxy/subagentModels';

const model = (name: string, enabled = true): CustomModel => ({
  name,
  enabled,
  displayName: 'Same visible label',
  description: '',
  provider: 'openai',
  apiUrl: 'http://127.0.0.1:1/v1',
  apiKey: '',
  externalModelName: 'shared-upstream',
});

describe('configured subagent model selection', () => {
  it('keeps effort variants distinct despite identical display and external names', () => {
    const models = [model('models/medium'), model('models/high')];
    for (const entry of models) {
      expect(resolveConfiguredSubagentModel(models, entry.name)).toBe(entry);
      expect(resolveConfiguredSubagentModel(models, localModelSlug(entry))).toBe(entry);
      expect(resolveConfiguredSubagentModel(models, `models/${catalogModelSlug(entry, models)}`)).toBe(entry);
    }
    expect(resolveConfiguredSubagentModel(models, 'Same visible label')).toBeUndefined();
    expect(resolveConfiguredSubagentModel(models, 'custom-shared-upstream')).toBeUndefined();
  });

  it('does not let a looser name match make a unique catalog alias ambiguous', () => {
    const qwen = { ...model('models/qwen'), displayName: 'Qwen coder', externalModelName: 'qwen3-coder' };
    const local = { ...model('models/local'), displayName: 'Local', externalModelName: 'coder' };
    const models = [qwen, local];
    expect(resolveConfiguredSubagentModel(models, 'custom-qwen3-coder')).toBe(qwen);
    expect(resolveConfiguredSubagentModel(models, 'models/custom-qwen3-coder')).toBe(qwen);
    expect(resolveConfiguredSubagentModel(models, 'coder')).toBe(local);
  });

  it('falls back to display or upstream names, then to the last path segment', () => {
    const omni = {
      ...model('models/custom/openrouter/omni-intelligent'),
      displayName: 'Omni',
      externalModelName: 'openrouter/omni-intelligent',
    };
    const other = { ...model('models/other'), displayName: 'Other', externalModelName: 'other-model' };
    const models = [omni, other];
    expect(resolveConfiguredSubagentModel(models, 'Omni')).toBe(omni);
    expect(resolveConfiguredSubagentModel(models, 'openrouter/omni-intelligent')).toBe(omni);
    expect(resolveConfiguredSubagentModel(models, 'models/custom/omni-intelligent')).toBe(omni);
    expect(resolveConfiguredSubagentModel(models, 'intelligent')).toBeUndefined();
  });

  it('rejects disabled entries and gives exact saved names priority over another entry alias', () => {
    const first = model('models/first');
    const disabled = model(`models/${localModelSlug(first)}`, false);
    const models = [first, disabled];
    expect(resolveConfiguredSubagentModel(models, disabled.name)).toBeUndefined();
    expect(resolveConfiguredSubagentModel(models, localModelSlug(disabled))).toBeUndefined();
    disabled.enabled = true;
    expect(resolveConfiguredSubagentModel(models, disabled.name)).toBe(disabled);
  });
});
