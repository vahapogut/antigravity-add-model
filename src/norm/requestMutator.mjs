import { defaultCatalogResolver } from './catalogResolver.mjs';

const UNSUPPORTED_NIM_APINEX_FIELDS = [
  'store',
  'service_tier',
  'stream_options',
  'parallel_tool_calls',
  'user',
];

const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>\s*/gi;
export const IMAGE_OMITTED_PLACEHOLDER = '[Image attachment omitted: target model is text-only]';

function shouldScrubReasoningHistory(modelId = '', providerUrl = '') {
  const target = `${modelId} ${providerUrl}`.toLowerCase();
  return (
    target.includes('integrate.api.nvidia.com') ||
    target.includes('nvidia') ||
    target.includes('apinex') ||
    target.includes('deepseek') ||
    target.includes('glm-5') ||
    target.includes('z-ai') ||
    target.includes('kimi-') ||
    target.includes('moonshot')
  );
}

function isStrictEndpoint(modelId = '', providerUrl = '') {
  const target = `${modelId} ${providerUrl}`.toLowerCase();
  return (
    target.includes('integrate.api.nvidia.com') ||
    target.includes('apinex') ||
    target.includes('nvidia/')
  );
}

function sanitizeTokenValue(val, fallbackMax, hardMax) {
  if (val === null || val === undefined || val === '') return undefined;
  const num = Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num) || num <= 0) {
    return fallbackMax;
  }
  if (hardMax && num > hardMax) {
    return hardMax;
  }
  return Math.floor(num);
}

function scrubThinkTagsFromText(text) {
  if (typeof text !== 'string') return text;
  if (!/<think>/i.test(text)) return text;
  return text.replace(THINK_BLOCK_REGEX, '').trim();
}

function normalizeCursorTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
    return {
      type: 'function',
      function: {
        name: String(tool.function.name || 'unnamed_tool'),
        description: String(tool.function.description || ''),
        parameters:
          tool.function.parameters && typeof tool.function.parameters === 'object'
            ? tool.function.parameters
            : { type: 'object', properties: {} },
      },
    };
  }
  // Flat Cursor-style tool definition: { name, description, parameters / input_schema }
  if (typeof tool.name === 'string' && tool.name.trim()) {
    const params = tool.parameters || tool.input_schema || tool.schema;
    return {
      type: 'function',
      function: {
        name: tool.name.trim(),
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters:
          params && typeof params === 'object' ? params : { type: 'object', properties: {} },
      },
    };
  }
  return tool;
}

export class RequestMutator {
  constructor(options = {}) {
    this.resolver = options.resolver || defaultCatalogResolver;
  }

  /**
   * Mutates and sanitizes an outgoing OpenAI-compatible `/v1/chat/completions` payload.
   * @param {Record<string, any>} payload Outgoing request body
   * @param {object} context Optional context: { modelId, providerUrl, spec, injectXmlToolFallback }
   * @returns {Record<string, any>} Sanitized request body
   */
  mutate(payload, context = {}) {
    if (!payload || typeof payload !== 'object') return payload;

    const body = { ...payload };
    const modelId = String(context.modelId || body.model || '');
    const providerUrl = String(context.providerUrl || '');
    const spec =
      context.spec || this.resolver.resolveModelSpec(modelId, providerUrl);

    const strictEndpoint = isStrictEndpoint(modelId, providerUrl);
    const fallbackTokens = Math.min(spec.maxOutputTokens || 8192, 16384);
    const maxAllowedTokens = spec.maxOutputTokens || 16384;

    // 1. max_tokens / max_completion_tokens Sanitization
    const hasMaxTokens = Object.prototype.hasOwnProperty.call(body, 'max_tokens');
    const hasMaxCompletionTokens = Object.prototype.hasOwnProperty.call(
      body,
      'max_completion_tokens',
    );

    if (hasMaxTokens) {
      const raw = body.max_tokens;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (raw === null || raw === undefined || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) {
        if (strictEndpoint) {
          body.max_tokens = fallbackTokens;
        } else {
          body.max_tokens = fallbackTokens;
        }
      } else if (num > maxAllowedTokens) {
        body.max_tokens = maxAllowedTokens;
      } else {
        body.max_tokens = Math.floor(num);
      }
    }

    if (hasMaxCompletionTokens) {
      const raw = body.max_completion_tokens;
      const num = typeof raw === 'number' ? raw : Number(raw);
      const sanitized = sanitizeTokenValue(raw, fallbackTokens, maxAllowedTokens);
      if (strictEndpoint) {
        // NVIDIA NIM & Apinex prefer standard max_tokens
        delete body.max_completion_tokens;
        if (!hasMaxTokens) {
          body.max_tokens = sanitized ?? fallbackTokens;
        }
      } else if (raw === null || raw === undefined || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) {
        if (hasMaxTokens) {
          delete body.max_completion_tokens;
        } else {
          body.max_completion_tokens = fallbackTokens;
        }
      } else if (num > maxAllowedTokens) {
        body.max_completion_tokens = maxAllowedTokens;
      }
    }

    if (!hasMaxTokens && !hasMaxCompletionTokens && strictEndpoint) {
      body.max_tokens = fallbackTokens;
    }

    // 2. Multi-Turn Reasoning History Scrubbing & 3. Vision / Multimodal Guard
    const scrubReasoning = shouldScrubReasoningHistory(modelId, providerUrl);
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((msg) => {
        if (!msg || typeof msg !== 'object') return msg;
        const cloned = { ...msg };

        // Assistant multi-turn reasoning cleanup
        if (cloned.role === 'assistant') {
          if (scrubReasoning) {
            delete cloned.reasoning_content;
            delete cloned.reasoning;
          } else if (cloned.reasoning_content === '') {
            // Never send empty string reasoning_content to OpenAI-compatible endpoints
            delete cloned.reasoning_content;
          }

          if (typeof cloned.content === 'string') {
            cloned.content = scrubThinkTagsFromText(cloned.content);
          } else if (Array.isArray(cloned.content)) {
            cloned.content = cloned.content.map((part) => {
              if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                return { ...part, text: scrubThinkTagsFromText(part.text) };
              }
              return part;
            });
          }
        }

        // Vision / Multimodal Guard for text-only models
        if (spec.supportsVision === false && Array.isArray(cloned.content)) {
          const hasImagePart = cloned.content.some(
            (part) =>
              part &&
              typeof part === 'object' &&
              (part.type === 'image_url' || part.type === 'image' || part.image_url),
          );
          if (hasImagePart) {
            const textSegments = cloned.content.map((part) => {
              if (!part || typeof part !== 'object') return '';
              if (part.type === 'image_url' || part.type === 'image' || part.image_url) {
                return IMAGE_OMITTED_PLACEHOLDER;
              }
              if (part.type === 'text' && typeof part.text === 'string') {
                return part.text;
              }
              return typeof part.content === 'string' ? part.content : '';
            }).filter(Boolean);
            cloned.content = textSegments.join('\n') || IMAGE_OMITTED_PLACEHOLDER;
          }
        }

        return cloned;
      });
    }

    // 4. Strict Schema & Cursor Tool Normalization
    if (strictEndpoint) {
      for (const field of UNSUPPORTED_NIM_APINEX_FIELDS) {
        delete body[field];
      }
    }

    if (Array.isArray(body.tools)) {
      if (spec.supportsTools === false) {
        const normalizedTools = body.tools.map(normalizeCursorTool).filter(Boolean);
        delete body.tools;
        delete body.tool_choice;
        if (context.injectXmlToolFallback && normalizedTools.length > 0 && Array.isArray(body.messages)) {
          const toolSummary = normalizedTools
            .map((t) => `- ${t.function?.name}: ${t.function?.description || ''}`)
            .join('\n');
          const fallbackPrompt = `\n\n[Available Tools (XML Fallback)]:\n${toolSummary}`;
          const sysIdx = body.messages.findIndex((m) => m && m.role === 'system');
          if (sysIdx >= 0 && typeof body.messages[sysIdx].content === 'string') {
            body.messages[sysIdx] = {
              ...body.messages[sysIdx],
              content: body.messages[sysIdx].content + fallbackPrompt,
            };
          }
        }
      } else {
        const normalizedTools = body.tools.map(normalizeCursorTool).filter(Boolean);
        if (normalizedTools.length > 0) {
          body.tools = normalizedTools;
        } else {
          delete body.tools;
          delete body.tool_choice;
        }
      }
    }

    return body;
  }
}

export const defaultRequestMutator = new RequestMutator();

export function mutateRequestPayload(payload, context = {}) {
  return defaultRequestMutator.mutate(payload, context);
}
