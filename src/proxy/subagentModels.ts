import type { CustomModel } from '../proxy';
import { catalogModelSlug, localModelSlug } from './modelCatalog';

const lastSegment = (value: string) => value.slice(value.lastIndexOf('/') + 1);

/** Resolve saved names first; ambiguous aliases and disabled entries never select another model. */
export function resolveConfiguredSubagentModel(models: CustomModel[], selector: string): CustomModel | undefined {
  const exact = models.find((model) => model.name === selector);
  if (exact) return exact.enabled !== false ? exact : undefined;
  const alias = selector.replace(/^models\//, '');
  // A looser tier is only consulted when every stricter tier found nothing, so a
  // fuzzy match can never make an alias that used to be unique ambiguous.
  const tiers: ((model: CustomModel) => boolean)[] = [
    (model) => catalogModelSlug(model, models) === alias || localModelSlug(model) === alias,
    (model) =>
      model.name === `models/${alias}` ||
      [model.displayName, model.externalModelName].some((name) => name === selector || name === alias),
    (model) =>
      [model.name, model.externalModelName].some(
        (name) => typeof name === 'string' && lastSegment(name) === lastSegment(alias),
      ),
  ];
  for (const tier of tiers) {
    const matches = models.filter(tier);
    if (matches.length) return matches.length === 1 && matches[0].enabled !== false ? matches[0] : undefined;
  }
  return undefined;
}
