import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

export const DEFAULT_CACHE_PATH = path.join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'models_catalog_cache.json',
);

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * Curated baseline specs for 2026 models and provider families.
 * Keyed by canonical normalized slug (lowercase, without vendor prefix or date suffix).
 */
const BUILTIN_SPECS = new Map([
  // Google
  [
    'gemini-3.8-pro',
    {
      contextWindow: 2097152,
      maxOutputTokens: 65536,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'thought',
    },
  ],
  [
    'gemini-3.8-flash',
    {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'thought',
    },
  ],
  [
    'gemma-4-31b-it',
    {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: false,
      reasoningFormat: 'none',
    },
  ],
  [
    'gemma-3-12b-it',
    {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: false,
      reasoningFormat: 'none',
    },
  ],

  // Anthropic
  [
    'claude-sonnet-4.6',
    {
      contextWindow: 200000,
      maxOutputTokens: 64000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'anthropic_thinking',
    },
  ],
  [
    'claude-opus-4.6',
    {
      contextWindow: 200000,
      maxOutputTokens: 64000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'anthropic_thinking',
    },
  ],

  // OpenAI
  [
    'gpt-oss-120b',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'gpt-oss-20b',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],

  // NVIDIA NIM & Partner Models
  [
    'nemotron-3-ultra-550b-a55b',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'nemotron-3.5-super-vl-120b-a12b',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'nemotron-3.5-lightning-30b-a3b',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'llama-3.1-nemotron-ultra-253b-v1',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'think_tags',
    },
  ],
  [
    'llama-3.1-nemotron-70b-instruct',
    {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      reasoningFormat: 'none',
    },
  ],
  [
    'kimi-k3',
    {
      contextWindow: 262144,
      maxOutputTokens: 16384,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'kimi-k2.6',
    {
      contextWindow: 262144,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'glm-5.3',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'glm-5.3-flash',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'glm-5.2',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'deepseek-v4.1-flash',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'deepseek-v4-pro',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'deepseek-v4',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'mistral-7b-instruct-v0.3',
    {
      contextWindow: 32768,
      maxOutputTokens: 8192,
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      reasoningFormat: 'none',
    },
  ],
  [
    'minimax-m3',
    {
      contextWindow: 1000000,
      maxOutputTokens: 16384,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'minimax-m3.1-flash',
    {
      contextWindow: 1000000,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
  [
    'laguna-xs-2.1',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      reasoningFormat: 'none',
    },
  ],
  [
    'step-5-preview',
    {
      contextWindow: 131072,
      maxOutputTokens: 16384,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningFormat: 'reasoning_content',
    },
  ],
]);

/**
 * Normalize a raw model ID into candidate lookup slugs.
 * Strips `models/`, `apinex/free/`, `:free`, vendor prefixes, and date suffixes (`-0813`, `-1017`, `-20250514`).
 */
export function normalizeModelSlug(rawModelId = '') {
  let slug = String(rawModelId || '').trim().toLowerCase();
  slug = slug.replace(/^models\//, '');
  slug = slug.replace(/^apinex\/free\//, '');
  slug = slug.replace(/^free\//, '');
  slug = slug.replace(/:free$/, '');
  slug = slug.replace(/:[a-z0-9._-]+$/, '');

  // Strip vendor prefix if present (e.g. nvidia/, moonshotai/, z-ai/, deepseek-ai/, mistralai/, minimaxai/, poolside/, stepfun-ai/, openai/, anthropic/, google/)
  const slashIdx = slug.lastIndexOf('/');
  const withoutVendor = slashIdx >= 0 ? slug.slice(slashIdx + 1) : slug;

  // Strip trailing 4-digit (MMDD) or 8-digit (YYYYMMDD) date stamps like -0813, -1017, -20260101
  const withoutDate = withoutVendor
    .replace(/-(?:20\d{6}|\d{4})$/, '')
    .replace(/-(?:latest|exp|experimental)$/, '');

  return {
    full: slug,
    withoutVendor,
    canonical: withoutDate,
  };
}

function fetchJsonUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Antigravity-OmniNorm/1.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > 25 * 1024 * 1024) {
            req.destroy(new Error(`Response too large from ${url}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

function parseModelsDevPayload(payload) {
  const entries = {};
  if (!payload || typeof payload !== 'object') return entries;

  const ingestModel = (id, modelObj) => {
    if (!id || !modelObj || typeof modelObj !== 'object') return;
    const { canonical, withoutVendor, full } = normalizeModelSlug(id);
    const limit = modelObj.limit || modelObj.limits || {};
    const modalities = modelObj.modalities || {};
    const inputMods = Array.isArray(modalities.input) ? modalities.input : [];
    const contextWindow =
      Number(limit.context || modelObj.context_length || modelObj.contextWindow) || 131072;
    const maxOutputTokens =
      Number(limit.output || modelObj.max_output_tokens || modelObj.maxOutputTokens) || 16384;
    const supportsVision = Boolean(
      modelObj.attachment ||
        modelObj.vision ||
        modelObj.supportsVision ||
        inputMods.includes('image') ||
        inputMods.includes('video'),
    );
    const supportsTools =
      modelObj.tool_call !== undefined
        ? Boolean(modelObj.tool_call)
        : modelObj.supportsTools !== undefined
          ? Boolean(modelObj.supportsTools)
          : true;
    const supportsReasoning = Boolean(
      modelObj.reasoning || modelObj.supportsReasoning || modelObj.thinking,
    );
    const spec = {
      contextWindow,
      maxOutputTokens,
      supportsVision,
      supportsTools,
      supportsReasoning,
      reasoningFormat: supportsReasoning ? 'reasoning_content' : 'none',
    };
    entries[full] = spec;
    entries[withoutVendor] = spec;
    entries[canonical] = spec;
  };

  for (const [providerKey, providerVal] of Object.entries(payload)) {
    if (!providerVal || typeof providerVal !== 'object') continue;
    if (providerVal.models && typeof providerVal.models === 'object') {
      for (const [modelId, modelData] of Object.entries(providerVal.models)) {
        ingestModel(`${providerKey}/${modelId}`, modelData);
        ingestModel(modelId, modelData);
      }
    } else if (providerVal.limit || providerVal.modalities || providerVal.context_length) {
      ingestModel(providerKey, providerVal);
    }
  }
  return entries;
}

function parseOpenRouterPayload(payload) {
  const entries = {};
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    const { canonical, withoutVendor, full } = normalizeModelSlug(item.id);
    const arch = item.architecture || {};
    const topProvider = item.top_provider || {};
    const supportedParams = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
    const inputMods = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const modalityStr = String(arch.modality || '').toLowerCase();

    const contextWindow = Number(item.context_length || topProvider.context_length) || 131072;
    const maxOutputTokens =
      Number(topProvider.max_completion_tokens || item.max_output_tokens) ||
      Math.min(16384, Math.max(4096, Math.floor(contextWindow / 8)));
    const supportsVision =
      inputMods.includes('image') || modalityStr.includes('image') || modalityStr.includes('multimodal');
    const supportsTools =
      supportedParams.length > 0
        ? supportedParams.includes('tools') || supportedParams.includes('tool_choice')
        : true;
    const supportsReasoning =
      supportedParams.includes('reasoning') ||
      supportedParams.includes('include_reasoning') ||
      Boolean(item.thinking);

    const spec = {
      contextWindow,
      maxOutputTokens,
      supportsVision,
      supportsTools,
      supportsReasoning,
      reasoningFormat: supportsReasoning ? 'reasoning_content' : 'none',
    };
    entries[full] = spec;
    entries[withoutVendor] = spec;
    entries[canonical] = spec;
  }
  return entries;
}

export class CatalogResolver {
  constructor(options = {}) {
    this.cachePath = options.cachePath || DEFAULT_CACHE_PATH;
    this.refreshIntervalMs = options.refreshIntervalMs ?? TWELVE_HOURS_MS;
    this.fetchFn = options.fetchFn || fetchJsonUrl;
    this.dynamicSpecs = new Map();
    this.lastUpdated = 0;
    this.refreshTimer = null;

    this.loadCacheFromDisk();
  }

  loadCacheFromDisk() {
    try {
      if (!fs.existsSync(this.cachePath)) return false;
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object') {
        this.lastUpdated = Number(raw.updatedAt) || 0;
        for (const [key, spec] of Object.entries(raw.models)) {
          this.dynamicSpecs.set(key, spec);
        }
        return true;
      }
    } catch {
      // Ignore corrupt cache and rebuild on next refresh
    }
    return false;
  }

  saveCacheToDisk() {
    try {
      const dir = path.dirname(this.cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const serialized = {
        updatedAt: this.lastUpdated || Date.now(),
        models: Object.fromEntries(this.dynamicSpecs.entries()),
      };
      const tmpPath = `${this.cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.cachePath);
    } catch {
      // Non-fatal if disk write fails
    }
  }

  async refreshCatalog(force = false) {
    const now = Date.now();
    if (!force && this.dynamicSpecs.size > 0 && now - this.lastUpdated < this.refreshIntervalMs) {
      return { cached: true, count: this.dynamicSpecs.size };
    }

    let merged = {};
    // 1. Secondary fallback first so primary overrides it
    try {
      const orData = await this.fetchFn('https://openrouter.ai/api/v1/models');
      merged = { ...merged, ...parseOpenRouterPayload(orData) };
    } catch {
      // Fallback optional
    }

    // 2. Primary source: models.dev/api.json (and models.dev/catalog.json fallback)
    try {
      const mdApi = await this.fetchFn('https://models.dev/api.json');
      merged = { ...merged, ...parseModelsDevPayload(mdApi) };
    } catch {
      try {
        const mdCatalog = await this.fetchFn('https://models.dev/catalog.json');
        merged = { ...merged, ...parseModelsDevPayload(mdCatalog) };
      } catch {
        // Offline or unreachable; rely on existing disk cache + builtin specs
      }
    }

    const keys = Object.keys(merged);
    if (keys.length > 0) {
      for (const [k, v] of Object.entries(merged)) {
        this.dynamicSpecs.set(k, v);
      }
      this.lastUpdated = Date.now();
      this.saveCacheToDisk();
    }

    return { cached: false, count: this.dynamicSpecs.size };
  }

  startAutoRefresh() {
    if (this.refreshTimer) return;
    void this.refreshCatalog(false).catch(() => {});
    this.refreshTimer = setInterval(() => {
      void this.refreshCatalog(true).catch(() => {});
    }, this.refreshIntervalMs);
    if (typeof this.refreshTimer.unref === 'function') {
      this.refreshTimer.unref();
    }
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Resolves normalized metadata for any model ID and provider URL using:
   * 1. Built-in curated 2026 model registry
   * 2. Cached models.dev / OpenRouter catalog (exact & fuzzy slug match)
   * 3. Heuristic fallbacks for vision, reasoning, tools, and token limits
   */
  /**
   * Returns the catalog entry (built-in or cached) that matches the model ID,
   * or undefined when the ID matches no known model.
   */
  findKnownSpec(rawModelId) {
    const { full, withoutVendor, canonical } = normalizeModelSlug(rawModelId);

    // 1. Check built-in curated registry first (exact canonical or withoutVendor)
    let matched =
      BUILTIN_SPECS.get(canonical) ||
      BUILTIN_SPECS.get(withoutVendor) ||
      BUILTIN_SPECS.get(full);

    // 2. Check dynamic catalog cache (exact match)
    if (!matched) {
      matched =
        this.dynamicSpecs.get(full) ||
        this.dynamicSpecs.get(withoutVendor) ||
        this.dynamicSpecs.get(canonical);
    }

    // 3. Fuzzy prefix/substring match against built-in and dynamic specs
    if (!matched && canonical) {
      for (const [key, spec] of BUILTIN_SPECS.entries()) {
        if (canonical.startsWith(key) || key.startsWith(canonical) || withoutVendor.includes(key)) {
          matched = spec;
          break;
        }
      }
    }
    if (!matched && canonical) {
      for (const [key, spec] of this.dynamicSpecs.entries()) {
        if (key && (canonical === key || canonical.startsWith(key + '-') || key.startsWith(canonical + '-'))) {
          matched = spec;
          break;
        }
      }
    }

    return matched || undefined;
  }

  /**
   * Like resolveModelSpec(), but returns undefined when the model ID matches
   * no known catalog entry, so callers can apply their own fallbacks.
   */
  lookupKnownSpec(rawModelId, providerUrl = '') {
    return this.findKnownSpec(rawModelId) ? this.resolveModelSpec(rawModelId, providerUrl) : undefined;
  }

  resolveModelSpec(rawModelId, providerUrl = '') {
    const { full, canonical } = normalizeModelSlug(rawModelId);
    const lowerUrl = String(providerUrl || '').toLowerCase();
    const isNvidiaNim = lowerUrl.includes('integrate.api.nvidia.com');
    const isApinex = lowerUrl.includes('apinex') || String(rawModelId || '').toLowerCase().includes('apinex/');
    const isAnthropic = lowerUrl.includes('anthropic.com') || full.includes('claude');
    const isGoogle =
      lowerUrl.includes('googleapis.com') || full.startsWith('gemini-') || full.startsWith('gemma-');

    const matched = this.findKnownSpec(rawModelId);

    // 4. Apply heuristic rules and provider-aware defaults
    const slugForHeuristics = `${full} ${canonical}`;
    const heuristicVision =
      /-vl-|vision|gemini-3|gemma-3|gemma-4|kimi-k3|claude|minimax-m3(?!\.1-flash)|step-5|gpt-4o|pixtral|llava|qwen.*-vl/i.test(
        slugForHeuristics,
      );
    const heuristicReasoning =
      /deepseek-v4|deepseek-r1|glm-5|kimi-k3|kimi-k2|nemotron-3|nemotron-ultra|minimax-m3|step-5|gemini-3|claude-(?:sonnet|opus)-4|gpt-oss|o1|o3|o4|qwq|thinking|reasoning/i.test(
        slugForHeuristics,
      );
    const heuristicNoTools = /mistral-7b-instruct-v0\.3|deepseek-r1-distill/i.test(slugForHeuristics);

    const base = matched
      ? { ...matched }
      : {
          contextWindow: isGoogle ? 1048576 : isAnthropic ? 200000 : 131072,
          maxOutputTokens: isGoogle ? 65536 : isAnthropic ? 64000 : 16384,
          supportsVision: heuristicVision,
          supportsTools: !heuristicNoTools,
          supportsReasoning: heuristicReasoning,
          reasoningFormat: heuristicReasoning
            ? isGoogle
              ? 'thought'
              : isAnthropic
                ? 'anthropic_thinking'
                : 'reasoning_content'
            : 'none',
        };

    // Ensure explicit heuristic guarantees required by OmniNorm spec are always honored
    if (/-vl-|vision|gemini-3|kimi-k3|claude/i.test(slugForHeuristics) && !matched) {
      base.supportsVision = true;
    } else if (/-vl-|vision|gemini-3|kimi-k3|claude/i.test(slugForHeuristics) && matched) {
      base.supportsVision = Boolean(matched.supportsVision || heuristicVision);
    }

    if (/deepseek-v4|glm-5|kimi-k3|nemotron-3|minimax-m3|step-5/i.test(slugForHeuristics)) {
      base.supportsReasoning = true;
      if (!base.reasoningFormat || base.reasoningFormat === 'none') {
        base.reasoningFormat = 'reasoning_content';
      }
    }

    // Clamp maxOutputTokens for NVIDIA NIM / Apinex if unspecified or out of range
    if ((isNvidiaNim || isApinex) && (!base.maxOutputTokens || base.maxOutputTokens > 32768)) {
      base.maxOutputTokens = 16384;
    }

    return {
      contextWindow: base.contextWindow || 131072,
      maxOutputTokens: base.maxOutputTokens || 8192,
      supportsVision: Boolean(base.supportsVision),
      supportsTools: base.supportsTools !== false,
      supportsReasoning: Boolean(base.supportsReasoning),
      reasoningFormat: base.reasoningFormat || (base.supportsReasoning ? 'reasoning_content' : 'none'),
    };
  }
}

export const defaultCatalogResolver = new CatalogResolver();

export function resolveModelSpec(rawModelId, providerUrl = '') {
  return defaultCatalogResolver.resolveModelSpec(rawModelId, providerUrl);
}
