import type { CustomModel } from '../proxy';
import type { ApiFormat } from '../providers';

export interface GeminiBody {
  contents?: { role?: string; parts?: { functionResponse?: unknown; [key: string]: unknown }[] }[];
  generationConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Fingerprints from the verified Antigravity IDE 2.5.5 language-server binary
 * and its observed live checkpoint request.
 * Only the final plain user turn can trigger it; quoted prompts, history, tool
 * output, and ordinary requests to summarize must retain the normal effort.
 */
export function isAntigravityCompactionRequest(body: GeminiBody): boolean {
  const last = body.contents?.[body.contents.length - 1];
  if (last?.role !== 'user' || !last.parts?.length) return false;
  if (last.parts.some((part) => typeof part.text !== 'string' || Object.keys(part).some((key) => key !== 'text')))
    return false;
  const text = last.parts
    .map((part) => part.text)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const legacyTemplate =
    text.startsWith(
      'You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the full conversation history will NOT be available',
    ) &&
    text.includes(
      'Do not call any tools, simply just provide the summary based on the information available in the current context window.',
    ) &&
    [
      '1. **Task Overview**',
      '2. **Progress**',
      '3. **Key Findings**',
      '4. **Active Context**',
      '5. **Next Steps**',
      '6. **Commitments & Constraints**',
    ].every((section) => text.includes(section)) &&
    text.endsWith('Wrap your response in <summary></summary> tags.');
  const sessionTemplate =
    text.startsWith('Your main task now is to generate a continuation summary of this session.') &&
    text.includes('Another agent will read ONLY this summary to continue the work.') &&
    [
      '1. Outstanding User Requests',
      '2. User Knowledge',
      '3. Work Accomplished',
      '4. Model Knowledge',
      '5. Files and Code',
      '6. Current Work and Next Steps',
    ].every((section) => text.includes(section)) &&
    text.endsWith(
      'Do not call any tools. You must respond directly with the summary without calling any tools or attempting further investigation.',
    );
  return legacyTemplate || sessionTemplate;
}

type CompactionEffort = NonNullable<CustomModel['compactionReasoningEffort']>;

function applyCompactionEffort(
  result: Record<string, unknown>,
  model: CustomModel,
  format: ApiFormat,
  effort: CompactionEffort,
): void {
  // Remove competing provider knobs, including ones supplied via extraBody.
  const reasoning =
    result.reasoning && typeof result.reasoning === 'object' && !Array.isArray(result.reasoning)
      ? { ...(result.reasoning as Record<string, unknown>) }
      : {};
  delete reasoning.effort;
  delete reasoning.max_tokens;
  delete reasoning.enabled;
  delete result.reasoning_effort;
  delete result.reasoning;
  delete result.thinking;
  delete result.thinking_budget;
  if (result.output_config && typeof result.output_config === 'object' && !Array.isArray(result.output_config)) {
    const output = { ...(result.output_config as Record<string, unknown>) };
    delete output.effort;
    if (Object.keys(output).length) result.output_config = output;
    else delete result.output_config;
  }
  const budget = { none: 0, minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[effort];
  if (format === 'openai') {
    // OpenRouter's unified reasoning object also covers non-OpenAI models.
    const openRouter = model.provider === 'openrouter' || /^https:\/\/openrouter\.ai(?:\/|$)/i.test(model.apiUrl);
    if (openRouter)
      result.reasoning =
        effort === 'none' ? { ...reasoning, effort: 'none', enabled: false } : { ...reasoning, effort, enabled: true };
    else result.reasoning_effort = effort;
  } else if (format === 'anthropic') {
    if (effort === 'none') result.thinking = { type: 'disabled' };
    else {
      const available = Number(result.max_tokens) - 1;
      if (available < 1024 || !Number.isFinite(available))
        throw new Error(
          'Compaction thinking requires maxOutputTokens greater than 1024 for Anthropic; use none to disable it.',
        );
      result.thinking = { type: 'enabled', budget_tokens: Math.min(budget, available) };
      delete result.temperature;
      delete result.top_p;
      delete result.top_k;
    }
  } else {
    const generation = { ...((result.generationConfig as Record<string, unknown>) || {}) };
    if (model.gateway) {
      // Gateway aliases do not reveal the eventual provider. Preserve the
      // explicit compaction choice for its provider-specific mapping instead.
      delete generation.thinkingConfig;
      generation.compactionReasoningEffort = effort;
      result.generationConfig = generation;
      return;
    }
    const name = (model.externalModelName || model.name).replace(/^models\//, '').toLowerCase();
    const version = name.match(/(?:^|\/)gemini-(\d+)(?:[.-]|$)/);
    if (version && Number(version[1]) >= 3) {
      // Gemini 3+ uses levels. Pro and newer Flash families cannot all use
      // minimal, so only request it from known supporting Flash families.
      const minimal = /(?:^|\/)gemini-(?:3-flash|3\.1-flash-lite|3\.5-flash-lite|3\.6-flash)(?:-|$)/.test(name);
      const level =
        effort === 'high' || effort === 'xhigh'
          ? 'HIGH'
          : effort === 'medium'
            ? 'MEDIUM'
            : minimal && (effort === 'none' || effort === 'minimal')
              ? 'MINIMAL'
              : 'LOW';
      generation.thinkingConfig = {
        thinkingLevel: /^gemini-3-pro(?:-|$)/.test(name) && level === 'MEDIUM' ? 'HIGH' : level,
      };
    } else {
      // Gemini 2.5 Pro has an always-on minimum of 128 tokens.
      generation.thinkingConfig = {
        thinkingBudget: effort === 'none' && /(?:^|\/)gemini-2\.5-pro(?:-|$)/.test(name) ? 128 : budget,
      };
    }
    result.generationConfig = generation;
  }
}

// A budgeting estimate, not a provider tokenizer. Image token costs depend on
// the model and dimensions; base64 byte counts are not text token counts.
const ESTIMATED_IMAGE_TOKENS = 1024;

type AttachmentField = 'inlineData' | 'fileData';

function isImageAttachment(field: AttachmentField, attachment: { mimeType?: unknown; fileUri?: unknown }): boolean {
  return (
    (typeof attachment.mimeType === 'string' && /^image\//i.test(attachment.mimeType.trim())) ||
    (field === 'fileData' && typeof attachment.fileUri === 'string' && /^data:image\//i.test(attachment.fileUri))
  );
}

/**
 * Blank every image payload on a copy of the part and report how many were found.
 * Tool media is nested in `functionResponse.parts`, so this must recurse; otherwise
 * a base64 screenshot inside a tool result would be billed as raw text.
 */
function estimatePart(part: Record<string, unknown>): { part: Record<string, unknown>; images: number } {
  let images = 0;
  let estimatedPart = part;
  for (const field of ['inlineData', 'fileData'] as const) {
    const attachment = part[field] as { mimeType?: unknown; data?: unknown; fileUri?: unknown } | undefined;
    if (!attachment || typeof attachment !== 'object') continue;
    if (!isImageAttachment(field, attachment)) continue;
    images += 1;
    estimatedPart = {
      ...estimatedPart,
      [field]: { ...attachment, [field === 'inlineData' ? 'data' : 'fileUri']: '' },
    };
  }
  const response = estimatedPart.functionResponse as { parts?: unknown } | undefined;
  if (response && typeof response === 'object' && Array.isArray(response.parts)) {
    const nested = response.parts.map((nestedPart) => {
      const estimate = estimatePart((nestedPart || {}) as Record<string, unknown>);
      images += estimate.images;
      return estimate.part;
    });
    estimatedPart = { ...estimatedPart, functionResponse: { ...response, parts: nested } };
  }
  return { part: estimatedPart, images };
}

function estimateContextTokens(body: GeminiBody): number {
  let imageTokens = 0;
  const estimatedBody = {
    ...body,
    contents: body.contents?.map((content) => ({
      ...content,
      parts: content.parts?.map((part) => {
        const estimate = estimatePart(part as Record<string, unknown>);
        imageTokens += estimate.images * ESTIMATED_IMAGE_TOKENS;
        return estimate.part;
      }),
    })),
  };
  return Math.ceil(Buffer.byteLength(JSON.stringify(estimatedBody), 'utf8') / 3) + imageTokens;
}

/** Approximate input budget. Drop whole oldest turns, never half a tool exchange. */
export function trimContext(body: GeminiBody, contextWindow?: number, maxOutputTokens = 0): GeminiBody {
  if (!contextWindow) return body;
  const budget = contextWindow - maxOutputTokens;
  const groups: NonNullable<GeminiBody['contents']>[] = [];
  for (const content of body.contents || []) {
    const startsTurn = content.role !== 'model' && !content.parts?.some((part) => part.functionResponse);
    if (!groups.length || startsTurn) groups.push([]);
    groups[groups.length - 1].push(content);
  }
  const result = { ...body, contents: groups.flat() };
  while (estimateContextTokens(result) > budget && groups.length > 1) {
    groups.shift();
    result.contents = groups.flat();
  }
  if (estimateContextTokens(result) > budget)
    throw new Error('The latest turn, system instructions and tools exceed the configured contextWindow.');
  return result;
}

export function applyRequestOptions(
  payload: Record<string, unknown>,
  model: CustomModel,
  format: ApiFormat,
  stream: boolean,
  compactionEffort?: CompactionEffort,
): Record<string, unknown> {
  const result = { ...payload };
  const reserved = new Set(['model', 'messages', 'contents', 'system', 'systemInstruction', 'tools', 'stream']);
  for (const [key, value] of Object.entries(model.extraBody || {})) {
    if (reserved.has(key)) throw new Error(`extraBody cannot override ${key}`);
    result[key] = value;
  }
  if (format === 'google') {
    delete result.stream;
    const generation = { ...((result.generationConfig as Record<string, unknown>) || {}) };
    if (model.maxOutputTokens !== undefined) generation.maxOutputTokens = model.maxOutputTokens;
    if (compactionEffort === undefined && model.thinkingBudget !== undefined)
      generation.thinkingConfig = { thinkingBudget: model.thinkingBudget };
    result.generationConfig = generation;
  } else {
    result.stream = stream;
    if (model.maxOutputTokens !== undefined) {
      if (format === 'openai' && result.max_completion_tokens !== undefined)
        result.max_completion_tokens = model.maxOutputTokens;
      else result.max_tokens = model.maxOutputTokens;
    }
    if (compactionEffort === undefined && format === 'openai' && model.reasoningEffort !== undefined)
      result.reasoning_effort = model.reasoningEffort;
    if (compactionEffort === undefined && format === 'anthropic' && model.thinkingBudget !== undefined) {
      if (model.thinkingBudget === 0) result.thinking = { type: 'disabled' };
      else {
        if (model.thinkingBudget < 1024 || model.thinkingBudget >= Number(result.max_tokens)) {
          throw new Error('Anthropic thinkingBudget must be at least 1024 and smaller than maxOutputTokens.');
        }
        result.thinking = { type: 'enabled', budget_tokens: model.thinkingBudget };
        delete result.temperature;
      }
    }
  }
  if (compactionEffort !== undefined) applyCompactionEffort(result, model, format, compactionEffort);
  return result;
}

export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return 0;
  const delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 30_000)) : 0;
}
