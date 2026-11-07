"use strict";
/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectToolSchemas = collectToolSchemas;
exports.normalizeToolArgs = normalizeToolArgs;
exports.normalizeToolSchema = normalizeToolSchema;
exports.fixParamTypes = fixParamTypes;
exports.translateToolCallToNative = translateToolCallToNative;
exports.formatTranslatedResponse = formatTranslatedResponse;
const path = __importStar(require("path"));
const electron_log_1 = __importDefault(require("electron-log"));
function collectToolSchemas(body) {
    const schemas = new Map();
    if (!body || typeof body !== 'object')
        return schemas;
    const tools = body.tools;
    if (!Array.isArray(tools))
        return schemas;
    for (const group of tools) {
        if (!group || !Array.isArray(group.functionDeclarations))
            continue;
        for (const declaration of group.functionDeclarations) {
            if (!declaration || typeof declaration.name !== 'string')
                continue;
            schemas.set(declaration.name, schemas.has(declaration.name) ? undefined : (declaration.parametersJsonSchema ?? declaration.parameters));
        }
    }
    return schemas;
}
// ─── Tool Parameter Normalization ──────────────────────────────────────────
const TOOL_PARAM_NORMALIZATION = {
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
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
/**
 * Resolve explicit legacy aliases only. Live declarations take precedence over
 * historical tool signatures; arbitrary values must never become file paths.
 */
function normalizeToolArgs(name, args, schemas) {
    if (!args || typeof args !== 'object')
        return args || {};
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
    if (!config)
        return normalized;
    let properties;
    if (schemas) {
        const schema = schemas.get(name);
        if (!schema || typeof schema !== 'object' || Array.isArray(schema))
            return normalized;
        const declared = schema.properties;
        if (!declared || typeof declared !== 'object' || Array.isArray(declared))
            return normalized;
        properties = declared;
    }
    const rules = [
        config,
        ...Object.entries(TOOL_PARAM_NORMALIZATION)
            .filter(([key]) => key.startsWith(name + '.'))
            .map(([, value]) => value),
    ];
    for (const [key, value] of Object.entries(args)) {
        // A valid caller-defined property is never renamed to a historical alias.
        if (properties && hasOwn(properties, key))
            continue;
        const rule = rules.find((candidate) => candidate.aliases.includes(key));
        if (!rule || (properties && !hasOwn(properties, rule.primaryKey)))
            continue;
        // Keep an explicit canonical argument even if a conflicting alias follows it.
        if (!hasOwn(normalized, rule.primaryKey))
            normalized[rule.primaryKey] = value;
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
function normalizeSchemaNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return;
    const schema = value;
    if (typeof schema.type === 'string')
        schema.type = schema.type.toLowerCase();
    else if (Array.isArray(schema.type)) {
        schema.type = schema.type.map((type) => (typeof type === 'string' ? type.toLowerCase() : type));
    }
    // Gemini's protobuf JSON can serialize these int64 bounds as decimal strings.
    // Do not silently round, truncate, or reinterpret malformed schema values.
    for (const keyword of SCHEMA_INTEGER_BOUNDS) {
        const bound = schema[keyword];
        if (typeof bound === 'string' && /^(?:0|[1-9]\d*)$/.test(bound)) {
            const number = Number(bound);
            if (Number.isSafeInteger(number))
                schema[keyword] = number;
        }
    }
    // Only schema-bearing keywords are traversed. Defaults, examples, enum/const
    // values, and extension metadata may contain identical keys as literal data.
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
        const map = schema[keyword];
        if (map && typeof map === 'object' && !Array.isArray(map)) {
            for (const child of Object.values(map))
                normalizeSchemaNode(child);
        }
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
        const children = schema[keyword];
        if (Array.isArray(children))
            children.forEach(normalizeSchemaNode);
    }
    if (Array.isArray(schema.items))
        schema.items.forEach(normalizeSchemaNode);
    else
        normalizeSchemaNode(schema.items);
    for (const keyword of SCHEMA_SINGLE_KEYWORDS)
        normalizeSchemaNode(schema[keyword]);
}
/** Return a provider-compatible copy without changing the caller's tool schema. */
function normalizeToolSchema(schema) {
    const normalized = JSON.parse(JSON.stringify(schema));
    normalizeSchemaNode(normalized);
    // Zero-argument tools can arrive as `{ type: 'object' }`. Strict OpenAI-compatible
    // servers such as LM Studio reject a root object without `properties` (issue #35).
    if (normalized.type === 'object' && normalized.properties === undefined)
        normalized.properties = {};
    return normalized;
}
/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
function fixParamTypes(properties) {
    if (!properties)
        return;
    for (const key of Object.keys(properties)) {
        const val = properties[key];
        if (val && typeof val === 'object') {
            const obj = val;
            if (typeof obj.type === 'string') {
                obj.type = obj.type.toLowerCase();
            }
            if (obj.properties && typeof obj.properties === 'object') {
                fixParamTypes(obj.properties);
            }
            if (obj.items && typeof obj.items === 'object') {
                const items = obj.items;
                if (typeof items.type === 'string') {
                    items.type = items.type.toLowerCase();
                }
                if (items.properties && typeof items.properties === 'object') {
                    fixParamTypes(items.properties);
                }
            }
        }
    }
}
/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
function translateToolCallToNative(name, args, schemas) {
    // With live declarations, preserve the requested tool and its semantics.
    // Guessing an equivalent file tool can introduce undeclared names/arguments.
    if (schemas)
        return { name, args: args };
    if (name !== 'run_command' || !args || !args.CommandLine) {
        return { name, args: args };
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
        electron_log_1.default.info(`[Proxy] Translating run_command "${cmd}" to list_dir on "${dirPath}"`);
        return { name: 'list_dir', args: { DirectoryPath: dirPath } };
    }
    // 2. view_file translation
    const catMatch = /^(cat|type)\s+(["']?)(.*?)\2$/i.exec(cmd);
    if (catMatch) {
        const filePath = catMatch[3].trim();
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        electron_log_1.default.info(`[Proxy] Translating run_command "${cmd}" to view_file on "${absPath}"`);
        return { name: 'view_file', args: { AbsolutePath: absPath } };
    }
    // 2b. write_file translation (echo redirect)
    const echoRedirectMatch = /^(echo|printf)\s+(.+?)\s*>\s*(.+)$/i.exec(cmd);
    if (echoRedirectMatch) {
        const content = echoRedirectMatch[2].replace(/^["']|["']$/g, '');
        const filePath = echoRedirectMatch[3].trim();
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        electron_log_1.default.info(`[Proxy] Translating run_command "${cmd}" to write_file on "${absPath}"`);
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
        }
        else {
            const tokens = cmd.split(/\s+/);
            query = tokens[tokens.length - 1];
        }
        const tokens = cmd.split(/\s+/);
        const pathToken = tokens.find((t, idx) => idx > 0 && !t.startsWith('-') && !t.startsWith('/') && !t.includes('"') && !t.includes("'") && t !== query);
        if (pathToken) {
            searchPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
        }
        if (query) {
            electron_log_1.default.info(`[Proxy] Translating run_command "${cmd}" to grep_search (Query: "${query}", Path: "${searchPath}")`);
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
    return { name, args: args };
}
/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
function formatTranslatedResponse(translatedInfo, responseData) {
    const { translatedName, cmd } = translatedInfo;
    electron_log_1.default.info(`[Proxy] Formatting native response back to CLI for translated tool "${translatedName}" (Cmd: "${cmd}")`);
    if (translatedName === 'list_dir') {
        if (Array.isArray(responseData)) {
            return responseData
                .map((item) => {
                const typeIndicator = item.isDir ? '<DIR>' : '     ';
                const sizeStr = item.isDir ? '' : ` (${item.sizeBytes || 0} bytes)`;
                return `${typeIndicator}  ${item.name}${sizeStr}`;
            })
                .join('\n');
        }
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            const items = data.files || data.children || [];
            if (Array.isArray(items)) {
                return items.map((item) => `${item.isDir ? '<DIR>' : '     '}  ${item.name}`).join('\n');
            }
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'view_file') {
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            return data.content || data.CodeContent || JSON.stringify(responseData);
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'grep_search') {
        if (Array.isArray(responseData)) {
            return responseData
                .map((match) => `${match.Filename}:${match.LineNumber}:${match.LineContent}`)
                .join('\n');
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'write_file') {
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            if (data.success)
                return `File written successfully: ${data.path || 'unknown'}`;
            return `Failed to write file: ${data.error || 'Unknown error'}`;
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
}
//# sourceMappingURL=utils.js.map