/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */

import * as path from 'path';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GeminiParameterProperties {
  type?: string;
  properties?: GeminiParameterProperties;
  items?: GeminiParameterProperties;
  [key: string]: unknown;
}

export interface ToolCallArgs {
  CommandLine?: string;
  Cwd?: string;
  [key: string]: unknown;
}

export interface TranslatedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd?: string;
}

export interface MatchResult {
  Filename: string;
  LineNumber: number;
  LineContent: string;
}

export interface DirectoryItem {
  name: string;
  isDir: boolean;
  sizeBytes?: number;
}

export interface FileListResponse {
  files?: DirectoryItem[];
  children?: DirectoryItem[];
  content?: string;
  CodeContent?: string;
}

export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;

/** Tool declarations belong to one request, never to a shared model/session cache. */
export type ToolSchemas = ReadonlyMap<string, unknown>;

export function collectToolSchemas(body: unknown): ToolSchemas {
  const schemas = new Map<string, unknown>();
  if (!body || typeof body !== 'object') return schemas;
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return schemas;
  for (const group of tools) {
    if (!group || !Array.isArray(group.functionDeclarations)) continue;
    for (const declaration of group.functionDeclarations) {
      if (!declaration || typeof declaration.name !== 'string') continue;
      schemas.set(
        declaration.name,
        schemas.has(declaration.name) ? undefined : (declaration.parametersJsonSchema ?? declaration.parameters),
      );
    }
  }
  return schemas;
}

// ─── Tool Parameter Normalization ──────────────────────────────────────────

const TOOL_PARAM_NORMALIZATION: Record<string, { primaryKey: string; aliases: string[] }> = {
  view_file: {
    primaryKey: 'AbsolutePath',
    aliases: [
      'absolute_path',
      'absolutePath',
      'path',
      'file_path',
      'filePath',
      'file',
      'filename',
      'FilePath',
      'FileName',
      'target',
      'source',
      'input',
      'uri',
    ],
  },
  list_dir: {
    primaryKey: 'DirectoryPath',
    aliases: [
      'directory_path',
      'directoryPath',
      'path',
      'dir_path',
      'dirPath',
      'dir',
      'directory',
      'folder',
      'FolderPath',
      'folder_path',
      'target',
      'root',
      'base',
    ],
  },
  grep_search: {
    primaryKey: 'Query',
    aliases: [
      'query',
      'search',
      'SearchQuery',
      'search_query',
      'searchQuery',
      'pattern',
      'Pattern',
      'regex',
      'Regex',
      'term',
      'keyword',
      'text',
      'needle',
    ],
  },
  'grep_search.SearchPath': {
    primaryKey: 'SearchPath',
    aliases: [
      'search_path',
      'searchPath',
      'path',
      'directory',
      'DirectoryPath',
      'directory_path',
      'folder',
      'dir',
      'root',
      'base',
    ],
  },
  replace_file_content: {
    primaryKey: 'TargetFile',
    aliases: [
      'target_file',
      'targetFile',
      'file',
      'AbsolutePath',
      'absolute_path',
      'filePath',
      'file_path',
      'path',
      'FilePath',
      'target',
      'filename',
      'source',
    ],
  },
  write_to_file: {
    primaryKey: 'TargetFile',
    aliases: [
      'AbsolutePath',
      'absolute_path',
      'absolutePath',
      'target_file',
      'targetFile',
      'path',
      'file_path',
      'filePath',
      'file',
      'FilePath',
    ],
  },
  write_file: {
    primaryKey: 'AbsolutePath',
    aliases: [
      'absolute_path',
      'absolutePath',
      'path',
      'file_path',
      'filePath',
      'file',
      'filename',
      'FilePath',
      'FileName',
      'target_file',
      'targetFile',
      'target',
      'dest',
      'destination',
    ],
  },
  run_command: {
    primaryKey: 'CommandLine',
    aliases: [
      'command_line',
      'commandLine',
      'cmd',
      'command',
      'Command',
      'Cmd',
      'shell_command',
      'shellCommand',
      'script',
      'exec',
      'execute',
    ],
  },
  'run_command.Cwd': {
    primaryKey: 'Cwd',
    aliases: ['cwd', 'working_dir', 'workingDirectory', 'working_directory', 'dir', 'directory', 'path', 'folder'],
  },
  read_file: {
    primaryKey: 'AbsolutePath',
    aliases: [
      'absolute_path',
      'absolutePath',
      'path',
      'file_path',
      'filePath',
      'file',
      'filename',
      'FilePath',
      'FileName',
      'target',
      'source',
      'input',
    ],
  },
  search_files: {
    primaryKey: 'SearchPath',
    aliases: [
      'search_path',
      'searchPath',
      'path',
      'directory',
      'DirectoryPath',
      'directory_path',
      'folder',
      'dir',
      'root',
      'base',
    ],
  },
  create_directory: {
    primaryKey: 'DirectoryPath',
    aliases: ['directory_path', 'directoryPath', 'path', 'dir_path', 'dirPath', 'dir', 'folder', 'target', 'name'],
  },
  delete_file: {
    primaryKey: 'AbsolutePath',
    aliases: [
      'absolute_path',
      'absolutePath',
      'path',
      'file_path',
      'filePath',
      'file',
      'filename',
      'FilePath',
      'target',
    ],
  },
  move_file: {
    primaryKey: 'SourcePath',
    aliases: [
      'source_path',
      'sourcePath',
      'source',
      'from',
      'src',
      'path',
      'file_path',
      'filePath',
      'AbsolutePath',
      'absolute_path',
    ],
  },
  'move_file.DestinationPath': {
    primaryKey: 'DestinationPath',
    aliases: ['destination_path', 'destinationPath', 'dest', 'destination', 'to', 'dst', 'target'],
  },
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Resolve explicit legacy aliases only. Live declarations take precedence over
 * historical tool signatures; arbitrary values must never become file paths.
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown> | null | undefined,
  schemas?: ToolSchemas,
): Record<string, unknown> {
  if (!args || typeof args !== 'object') return args || {};

  // Handle array args
  if (Array.isArray(args)) {
    const config = hasOwn(TOOL_PARAM_NORMALIZATION, name) ? TOOL_PARAM_NORMALIZATION[name] : undefined;
    if (!schemas && config && args.length > 0 && typeof args[0] === 'string') {
      return { [config.primaryKey]: args[0] };
    }
    return {};
  }

  const config = hasOwn(TOOL_PARAM_NORMALIZATION, name) ? TOOL_PARAM_NORMALIZATION[name] : undefined;
  const normalized = { ...args };
  if (!config) return normalized;
  let properties: Record<string, unknown> | undefined;
  if (schemas) {
    const schema = schemas.get(name);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return normalized;
    const declared = (schema as { properties?: unknown }).properties;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return normalized;
    properties = declared as Record<string, unknown>;
  }
  const rules = [
    config,
    ...Object.entries(TOOL_PARAM_NORMALIZATION)
      .filter(([key]) => key.startsWith(name + '.'))
      .map(([, value]) => value),
  ];
  for (const [key, value] of Object.entries(args)) {
    // A valid caller-defined property is never renamed to a historical alias.
    if (properties && hasOwn(properties, key)) continue;
    const rule = rules.find((candidate) => candidate.aliases.includes(key));
    if (!rule || (properties && !hasOwn(properties, rule.primaryKey))) continue;
    // Keep an explicit canonical argument even if a conflicting alias follows it.
    if (!hasOwn(normalized, rule.primaryKey)) normalized[rule.primaryKey] = value;
    delete normalized[key];
  }
  return normalized;
}

// ─── Utility Functions ────────────────────────────────────────────────────

const SCHEMA_INTEGER_BOUNDS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
];
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
];
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_SINGLE_KEYWORDS = [
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
];

function normalizeSchemaNode(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (typeof schema.type === 'string') schema.type = schema.type.toLowerCase();
  else if (Array.isArray(schema.type)) {
    schema.type = schema.type.map((type) => (typeof type === 'string' ? type.toLowerCase() : type));
  }

  // Gemini's protobuf JSON can serialize these int64 bounds as decimal strings.
  // Do not silently round, truncate, or reinterpret malformed schema values.
  for (const keyword of SCHEMA_INTEGER_BOUNDS) {
    const bound = schema[keyword];
    if (typeof bound === 'string' && /^(?:0|[1-9]\d*)$/.test(bound)) {
      const number = Number(bound);
      if (Number.isSafeInteger(number)) schema[keyword] = number;
    }
  }

  // Only schema-bearing keywords are traversed. Defaults, examples, enum/const
  // values, and extension metadata may contain identical keys as literal data.
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const child of Object.values(map)) normalizeSchemaNode(child);
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (Array.isArray(children)) children.forEach(normalizeSchemaNode);
  }
  if (Array.isArray(schema.items)) schema.items.forEach(normalizeSchemaNode);
  else normalizeSchemaNode(schema.items);
  for (const keyword of SCHEMA_SINGLE_KEYWORDS) normalizeSchemaNode(schema[keyword]);
}

/** Return a provider-compatible copy without changing the caller's tool schema. */
export function normalizeToolSchema(schema: object): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  normalizeSchemaNode(normalized);
  if ((normalized.type === 'object' || !normalized.type) && (!normalized.properties || typeof normalized.properties !== 'object')) {
    normalized.properties = {};
  }
  return normalized;
}

/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export function fixParamTypes(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const key of Object.keys(properties)) {
    const val = properties[key];
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.type === 'string') {
        obj.type = (obj.type as string).toLowerCase();
      }
      if (obj.properties && typeof obj.properties === 'object') {
        fixParamTypes(obj.properties as Record<string, unknown>);
      }
      if (obj.items && typeof obj.items === 'object') {
        const items = obj.items as Record<string, unknown>;
        if (typeof items.type === 'string') {
          items.type = (items.type as string).toLowerCase();
        }
        if (items.properties && typeof items.properties === 'object') {
          fixParamTypes(items.properties as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
export function translateToolCallToNative(name: string, args: ToolCallArgs, schemas?: ToolSchemas): TranslatedToolCall {
  // With live declarations, preserve the requested tool and its semantics.
  // Guessing an equivalent file tool can introduce undeclared names/arguments.
  if (schemas) return { name, args: args as Record<string, unknown> };
  if (name !== 'run_command' || !args || !args.CommandLine) {
    return { name, args: args as Record<string, unknown> };
  }

  const cmd = args.CommandLine.trim();
  const cwd = args.Cwd || process.cwd();

  // 1. list_dir translation
  const isListDir = /^(ls|dir)(\s+[\w\-\/\.\*]+)*$/i.test(cmd);
  if (isListDir) {
    let dirPath = cwd;
    const tokens = cmd.split(/\s+/).slice(1);
    const pathToken = tokens.find((t) => !t.startsWith('-') && !t.startsWith('/'));
    if (pathToken) {
      dirPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
    }
    log.info(`[Proxy] Translating run_command "${cmd}" to list_dir on "${dirPath}"`);
    return { name: 'list_dir', args: { DirectoryPath: dirPath } };
  }

  // 2. view_file translation
  const catMatch = /^(cat|type)\s+(["']?)(.*?)\2$/i.exec(cmd);
  if (catMatch) {
    const filePath = catMatch[3].trim();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    log.info(`[Proxy] Translating run_command "${cmd}" to view_file on "${absPath}"`);
    return { name: 'view_file', args: { AbsolutePath: absPath } };
  }

  // 2b. write_file translation (echo redirect)
  const echoRedirectMatch = /^(echo|printf)\s+(.+?)\s*>\s*(.+)$/i.exec(cmd);
  if (echoRedirectMatch) {
    const content = echoRedirectMatch[2].replace(/^["']|["']$/g, '');
    const filePath = echoRedirectMatch[3].trim();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    log.info(`[Proxy] Translating run_command "${cmd}" to write_file on "${absPath}"`);
    return { name: 'write_file', args: { AbsolutePath: absPath, Content: content, Append: cmd.includes('>>') } };
  }

  // 3. grep_search translation
  if (cmd.toLowerCase().startsWith('grep') || cmd.toLowerCase().startsWith('findstr')) {
    let query = '';
    let searchPath = cwd;
    const regexQuotes = /"([^"]+)"|'([^']+)'/g;
    const quotesFound = [...cmd.matchAll(regexQuotes)];
    if (quotesFound.length > 0) {
      query = quotesFound[0][1] || quotesFound[0][2];
    } else {
      const tokens = cmd.split(/\s+/);
      query = tokens[tokens.length - 1];
    }
    const tokens = cmd.split(/\s+/);
    const pathToken = tokens.find(
      (t, idx) =>
        idx > 0 && !t.startsWith('-') && !t.startsWith('/') && !t.includes('"') && !t.includes("'") && t !== query,
    );
    if (pathToken) {
      searchPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
    }
    if (query) {
      log.info(`[Proxy] Translating run_command "${cmd}" to grep_search (Query: "${query}", Path: "${searchPath}")`);
      return {
        name: 'grep_search',
        args: {
          Query: query,
          SearchPath: searchPath,
          CaseInsensitive: cmd.includes('-i') || cmd.toLowerCase().includes('/i'),
          IsRegex: false,
          MatchPerLine: true,
        },
      };
    }
  }

  return { name, args: args as Record<string, unknown> };
}

/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
export function formatTranslatedResponse(translatedInfo: TranslatedCallInfo, responseData: unknown): string {
  const { translatedName, cmd } = translatedInfo;
  log.info(`[Proxy] Formatting native response back to CLI for translated tool "${translatedName}" (Cmd: "${cmd}")`);

  if (translatedName === 'list_dir') {
    if (Array.isArray(responseData)) {
      return (responseData as DirectoryItem[])
        .map((item) => {
          const typeIndicator = item.isDir ? '<DIR>' : '     ';
          const sizeStr = item.isDir ? '' : ` (${item.sizeBytes || 0} bytes)`;
          return `${typeIndicator}  ${item.name}${sizeStr}`;
        })
        .join('\n');
    }
    if (responseData && typeof responseData === 'object') {
      const data = responseData as FileListResponse;
      const items = data.files || data.children || [];
      if (Array.isArray(items)) {
        return items.map((item) => `${item.isDir ? '<DIR>' : '     '}  ${item.name}`).join('\n');
      }
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'view_file') {
    if (responseData && typeof responseData === 'object') {
      const data = responseData as FileListResponse;
      return data.content || data.CodeContent || JSON.stringify(responseData);
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'grep_search') {
    if (Array.isArray(responseData)) {
      return (responseData as MatchResult[])
        .map((match) => `${match.Filename}:${match.LineNumber}:${match.LineContent}`)
        .join('\n');
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'write_file') {
    if (responseData && typeof responseData === 'object') {
      const data = responseData as Record<string, unknown>;
      if (data.success) return `File written successfully: ${data.path || 'unknown'}`;
      return `Failed to write file: ${data.error || 'Unknown error'}`;
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
}
