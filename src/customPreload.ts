/** Custom-model UI, appended to the vendor preload. Sandboxed preloads require Electron only. */
import { ipcRenderer } from 'electron';

interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  apiFormat?: string;
  enabled?: boolean;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  [key: string]: unknown;
}
interface ProviderPreset {
  id: string;
  label: string;
  defaultUrl: string;
  apiFormat: string;
  keyRequired: boolean;
}
interface ModelChoice {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}
interface ActionResult {
  success: boolean;
  error?: string;
  message?: string;
  count?: number;
  status?: number;
}
interface DiscoveryResult extends ActionResult {
  models?: ModelChoice[];
}
interface DiagnosticsSnapshot extends ActionResult {
  active: number;
  summary: Record<string, number>;
  recentModels: string[];
  requests: {
    model: string;
    provider: string;
    timestamp: number;
    outcome: string;
    status?: number;
    latencyMs: number;
    stream: boolean;
    kind: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }[];
}
interface GatewayConfig {
  url: string;
  token: string;
  dashboardUrl: string;
}
interface GoogleAccountEntry {
  id: string;
  label?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  project?: string;
  authMode?: 'custom' | 'antigravity';
  cloudCodeEndpoint?: string;
  enabled?: boolean;
}
interface QuotaBucket {
  id: string;
  displayName?: string;
  groupName?: string;
  remainingFraction?: number;
  resetTime?: string;
}
interface AccountQuota {
  buckets: QuotaBucket[];
  groups?: { name?: string; displayName?: string; buckets?: QuotaBucket[] }[];
  planTier?: string;
  email?: string;
}
const storageAPI = {
  getCustomModels: (): Promise<CustomModelEntry[]> => ipcRenderer.invoke('storage:get-custom-models'),
  saveCustomModel: (model: CustomModelEntry): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:save-custom-model', model),
  deleteCustomModel: (name: string): Promise<ActionResult> => ipcRenderer.invoke('storage:delete-custom-model', name),
  testModelConnection: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-connection', model),
  testModelGeneration: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-generation', model),
  getPresets: (): Promise<ProviderPreset[]> => ipcRenderer.invoke('storage:get-provider-presets'),
  discoverModels: (params: Partial<CustomModelEntry>): Promise<DiscoveryResult> =>
    ipcRenderer.invoke('storage:discover-models', params),
};

function initCustomPreload(): void {
  function isChinese(): boolean {
    try {
      const stored = localStorage.getItem('agy_custom_models_lang');
      if (stored === 'zh') return true;
      if (stored === 'en') return false;
      if (typeof navigator !== 'undefined') {
        if (/^zh\b/i.test(navigator.language)) return true;
        if (navigator.languages?.some((l) => /^zh\b/i.test(l))) return true;
      }
      if (typeof document !== 'undefined') {
        if (/zh/i.test(document.documentElement.lang)) return true;
        if (
          document.querySelector(
            '[role="dialog"][aria-label*="设置"], [role="dialog"][aria-label*="偏好设置"], [role="dialog"][aria-label*="驱动模型"]',
          ) ||
          document.querySelector('.settings-modal-container')?.textContent?.includes('驱动模型') ||
          document.querySelector('nav')?.textContent?.includes('通用常规') ||
          document.body?.textContent?.includes('驱动模型与用量')
        ) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  const zhDict: Record<string, string> = {
    // Toolbar & main panel
    'Custom Models': '自定义模型',
    'Provider connections, local models and remote gateways.': '提供商连接、本地模型与远程网关。',
    'Add model': '添加模型',
    'Discover local': '发现本地模型',
    'Import': '导入',
    'Export': '导出',
    'Remote gateway': '远程网关',
    'Diagnostics': '诊断',
    'Search models': '搜索模型',
    'Search by name, model ID or provider': '按名称、模型 ID 或提供商搜索',
    'Search models…': '搜索模型…',
    'No matching models': '未找到匹配的模型',
    'English': 'English',
    '中文': '中文',

    // Group & Model row
    'Discover models': '发现模型',
    'Disable group': '禁用分组',
    'Enable group': '启用分组',
    'enabled': '已启用',
    'Enable': '启用',
    'Disable': '禁用',
    'Test': '测试',
    'Test generation': '生成测试',
    'Edit': '编辑',
    'Duplicate': '复制',
    'Effort variants': '思考变体',
    'Delete': '删除',
    'Testing…': '正在测试…',
    'Testing...': '正在测试...',
    'Valid connection': '连接正常',
    'Connection successful.': '连接成功。',
    'Connection failed': '连接失败',
    'Default endpoint': '默认端点',
    'Direct endpoint': '直连端点',
    'Effort': '思考强度',
    'Context': '上下文',
    'Max output': '最大输出',
    'Vision': '视觉',
    'Encrypted': '已加密',
    'Insecure TLS': '非安全 TLS',
    'Fallback': '回退',
    'No models match this search.': '未找到匹配当前搜索的模型。',
    'Not currently available in the native model picker. Direct API access remains available.': '暂无法在原生模型选择器中使用。直连 API 访问不受影响。',

    // Modals
    'Close': '关闭',
    'Cancel': '取消',
    'Save': '保存',
    'Delete model': '删除模型',
    'Add custom model': '添加自定义模型',
    'Edit custom model': '编辑自定义模型',
    'Edit model': '编辑模型',
    'Duplicate model': '复制模型',
    'Discover provider models': '发现提供商模型',
    'Create reasoning variants': '创建思考强度变体',
    'Test model generation': '测试模型生成',
    'Local model servers': '本地模型服务',
    'Proxy diagnostics': '代理诊断信息',
    'Import models': '导入模型',
    'Export models': '导出模型',
    'Save model': '保存模型',
    'Save changes': '保存更改',
    'Create duplicate': '创建副本',
    'Test connection': '测试连接',
    'Test generation (may incur charges)': '测试生成 (可能产生费用)',
    'Fetch provider models': '获取提供商模型',
    'Add selected models': '添加所选模型',
    'Add selected': '添加所选',
    'Select all': '全选',
    'Clear selection': '清空选择',
    'Select filtered': '全选筛选结果',
    'This removes the saved model configuration from this app.': '此操作将从应用中移除已保存的模型配置。',

    // Fields
    'Provider': '提供商',
    'Provider preset': '提供商预设',
    'API URL': 'API 地址',
    'API key': 'API 密钥',
    'OpenCode authentication': 'OpenCode 身份验证',
    'API format': 'API 格式',
    'Provider model ID': '提供商模型 ID',
    'Model ID': '模型 ID',
    'Display name': '显示名称',
    'Configuration name (unique)': '配置名称 (唯一)',
    'Config name': '配置名称',
    'Description': '描述',
    'Default Cloud Code project (optional)': '默认 Cloud Code 项目 (可选)',
    'Cloud project (optional)': 'Cloud 项目 (可选)',
    'Account selection': '账号选择策略',
    'Maximum requests per account': '单账号最大并发请求数',
    'Account cooldown (milliseconds)': '账号冷却时间 (毫秒)',
    'Native Google request fallback': '原生 Google 请求回退',
    'Advanced settings': '高级设置',
    'Reasoning effort': '思考强度',
    'Thinking budget (tokens)': '思考预算 (Token)',
    'Compaction reasoning effort': '压缩思考强度',
    'Maximum output tokens': '最大输出 Token 数',
    'Context window (tokens)': '上下文窗口 (Token 数)',
    'IDE compaction threshold (%)': 'IDE 压缩触发阈值 (%)',
    'Request timeout (milliseconds)': '请求超时时间 (毫秒)',
    'Maximum retries (0–5)': '最大重试次数 (0–5)',
    'Image input': '图片/视觉输入',
    'Endpoint path': '端点路径',
    'TLS certificates': 'TLS 证书验证',
    'Model state': '模型状态',
    'Fallback model configuration names (comma separated)': '回退模型配置名称 (逗号分隔)',
    'Custom headers (JSON)': '自定义请求头 (JSON)',
    'Additional request fields (JSON)': '附加请求字段 (JSON)',
    'Circuit breaker': '熔断保护',
    'Failures before cooldown': '触发冷却的连续失败次数',
    'Cooldown (milliseconds)': '冷却时长 (毫秒)',
    'Search provider models': '搜索提供商模型',
    'Filter by model name or ID': '按模型名称或 ID 过滤',

    // Select options
    'OpenAI compatible': '兼容 OpenAI',
    'Anthropic Messages': 'Anthropic Messages',
    'Google Gemini': 'Google Gemini',
    'Round robin': '轮询 (Round-robin)',
    'Least loaded': '最少负载 (Least-loaded)',
    'Remaining quota': '剩余配额 (Remaining quota)',
    'Adaptive health and load': '自适应健康与负载 (Adaptive)',
    'Auto detect': '自动检测',
    'Supported': '支持',
    'Unsupported': '不支持',
    'Normalize for provider': '按提供商规范化',
    'Use exactly as entered': '完全按输入使用',
    'Verify certificates': '验证证书 (安全)',
    'Allow self-signed certificates': '允许自签名证书 (非安全)',
    'Enabled': '已启用',
    'Disabled': '已禁用',
    'Default': '默认',
    'Off': '关闭',
    'Use this pool for matching native models': '对匹配的原生模型使用此账号池',
    'Provider default': '提供商默认',
    'Use normal model settings': '使用普通模型设置',
    'None': '无',
    'Bearer token': 'Bearer 令牌',
    'Keyless request': '免 Key 请求',
    'Antigravity account': 'Antigravity 账号',
    'My Desktop OAuth client': '我的 Desktop OAuth 客户端',

    // Placeholders & hints
    'Enter provider API key': '输入提供商 API 密钥',
    'Optional for local servers': '本地服务可选',
    'Generated from provider and model ID when left blank': '留空时将根据提供商和模型 ID 自动生成',
    'IDE default': 'IDE 默认',

    // Reasoning variants modal
    'Create three variants': '创建思考强度变体',

    // Test generation modal
    'Test prompt': '测试提示词',
    'Say hello in 5 words.': '请用5个字打个招呼。',
    'Run generation test': '运行生成测试',
    'Response': '响应结果',

    // Diagnostics modal
    'Filter by model or provider': '按模型或提供商过滤',
    'Refresh diagnostics': '刷新诊断',
    'Export diagnostics': '导出诊断报告',
    'Clear diagnostic history': '清空诊断历史',

    // Gateway modal
    'Gateway URL': '网关地址',
    'Gateway token': '网关令牌',
    'Dashboard URL (optional)': '控制台地址 (可选)',
    'Save connection': '保存连接',
    'Test gateway': '测试网关',
    'Import model aliases': '导入模型别名',
    'Open dashboard': '打开控制台',
    'Remove': '移除',

    // Import / Export
    'Copy JSON': '复制 JSON',
    'Import configuration': '导入配置',
    'Or choose a JSON file': '或者选择 JSON 文件',
    'Credential JSON file': '凭据 JSON 文件',

    // Local discovery
    'Configure': '配置',

    // Google Fleet & Accounts
    'Google accounts': 'Google 账号',
    'Google account fleet': 'Google 账号集群',
    'accounts': '个账号',
    '+ Add Account': '+ 添加账号',
    'Add account': '添加账号',
    'Import accounts': '导入账号',
    'Edit account': '编辑账号',
    'Add account credentials': '添加账号凭据',
    'Cancel account edit': '取消账号编辑',
    'Edit label': '编辑标签',
    'Remove from fleet': '从集群中移除',
    'Disable account': '禁用账号',
    'Enable account': '启用账号',
    'Automatic': '自动',
    'Use preferred': '优先使用',
    'Preferred': '首选',
    'Partially enabled': '部分启用',
    'Reconnect': '重新连接',
    'Refresh quotas': '刷新配额',
    'Refreshing quotas…': '正在刷新配额…',
    'Some pools enabled': '部分模型池已启用',
    'Loading quota…': '正在加载配额…',
    'Quota unavailable — Google returned no buckets.': '配额不可用 — Google 未返回配额桶。',
    'Daily requests': '每日请求数',
    'Minute requests': '每分钟请求数',
    'Tokens': 'Token 用量',
    'Weekly limit': '每周限制',
    'Five-hour limit': '5小时限制',
    'Daily limit': '每日限制',
    'Reported quota': '已上报配额',
    'Remaining quota unknown': '剩余配额未知',
    'No Google accounts configured.': '未配置 Google 账号。',
    'Sign in with Google': '使用 Google 登录',
    'Sign-in method': '登录方式',
    'Account label': '账号标签',
    'Desktop OAuth client ID': 'Desktop OAuth 客户端 ID',
    'OAuth client secret (if required)': 'OAuth 客户端密钥 (如需要)',
    'Apply account': '应用账号',
    'Prepare account': '准备账号',
    'Test account': '测试账号',
    'Cancel Google login': '取消 Google 登录',
    'Import account credentials': '导入账号凭据',
    'Account ID': '账号 ID',
    'Refresh token': 'Refresh Token',
    'Access token (optional with refresh token)': 'Access Token (配合 Refresh Token 可选)',
    'Access token expiry (Unix milliseconds)': 'Access Token 过期时间 (Unix 毫秒)',
    'Save account label': '保存账号标签',
    'Remove Google account': '移除 Google 账号',
    'Remove account from fleet': '从集群中移除账号',
    'Remove from all pools': '从所有模型池中移除',
    'Remove account': '移除账号',
    'Pool for new Google account': '新 Google 账号所属模型池',
  };

  function t(en: string, zh?: string): string {
    if (!isChinese()) return en;
    if (zh) return zh;
    return zhDict[en] || en;
  }

  let modelList: CustomModelEntry[] = [];
  let renderVersion = 0;
  let searchTerm = '';
  let cancelModalOperation: (() => void) | undefined;
  const requireSuccess = (result: ActionResult): ActionResult => {
    if (!result?.success) throw new Error(result?.error || 'The operation could not be completed.');
    return result;
  };
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function setStatus(target: HTMLElement, text: string, error = false): void {
    target.textContent = text;
    target.className = `agy-status${error ? ' agy-error' : ''}`;
  }
  function statusNode(): HTMLElement {
    const node = element('div', 'agy-status');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  }
  function button(
    label: string,
    action: () => void | Promise<void>,
    status?: HTMLElement,
    primary = false,
  ): HTMLButtonElement {
    const node = element('button', `agy-btn${primary ? ' agy-primary' : ''}`, t(label));
    node.type = 'button';
    node.addEventListener('click', async () => {
      // Fleet saves read and replace complete model records. Other settings
      // actions must not submit an older record while that transaction is pending.
      if (node.disabled || fleetBusy) return;
      node.disabled = true;
      try {
        await action();
      } catch (error) {
        const target = status || document.getElementById('agy-main-status');
        if (target) setStatus(target, error instanceof Error ? error.message : String(error), true);
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }
  function field(parent: HTMLElement, title: string, id: string, value = '', type = 'text'): HTMLInputElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', t(title)));
    const input = element('input');
    input.id = id;
    input.type = type;
    input.value = value;
    input.autocomplete = 'off';
    label.append(input);
    parent.append(label);
    return input;
  }
  function selectField(
    parent: HTMLElement,
    title: string,
    id: string,
    options: [string, string][],
    value: string,
  ): HTMLSelectElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', t(title)));
    const select = element('select');
    select.id = id;
    for (const [key, caption] of options) {
      const option = element('option', '', t(caption));
      option.value = key;
      select.append(option);
    }
    select.value = value;
    label.append(select);
    parent.append(label);
    return select;
  }
  function jsonField(parent: HTMLElement, title: string, id: string, value: unknown): HTMLTextAreaElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('textarea');
    input.id = id;
    input.rows = 3;
    input.spellcheck = false;
    input.value = value ? JSON.stringify(value, null, 2) : '';
    input.placeholder = '{}';
    label.append(input);
    parent.append(label);
    return input;
  }
  function readJson(input: HTMLTextAreaElement, title: string): Record<string, unknown> | undefined {
    if (!input.value.trim()) return undefined;
    try {
      const value = JSON.parse(input.value);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
      return value;
    } catch {
      throw new Error(`${title} must be a JSON object.`);
    }
  }
  function readNumber(input: HTMLInputElement, title: string, minimum = 0): number | undefined {
    if (!input.value.trim()) return undefined;
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`${title} must be a whole number of at least ${minimum}.`);
    return value;
  }
  function validUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Enter a complete http:// or https:// API URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL. Enter credentials in the API key field.');
    return value.trim();
  }
  function installStyles(): void {
    if (document.getElementById('agy-manager-style')) return;
    const style = element('style');
    style.id = 'agy-manager-style';
    style.textContent = `
      #agy-custom-models-section,#agy-modal-overlay{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e4e7;box-sizing:border-box}
      #agy-custom-models-section *,#agy-modal-overlay *{box-sizing:border-box}
      #agy-custom-models-section [hidden],#agy-modal-overlay [hidden]{display:none!important}
      #agy-custom-models-section{margin:24px 0;padding:20px;border:1px solid #303036;border-radius:12px;background:#18181b;min-width:0}
      #agy-custom-models-section h2,#agy-modal-overlay h2{font-size:18px;margin:0;color:#fafafa;font-weight:600}
      #agy-custom-models-section h3{font-size:13px;margin:0;color:#f4f4f5}
      .agy-toolbar,.agy-actions,.agy-group-heading,.agy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .agy-toolbar{justify-content:space-between;margin-bottom:12px}.agy-actions{margin:10px 0}
      .agy-muted{color:#a1a1aa;font-size:12px;overflow-wrap:anywhere}.agy-group{margin-top:16px;border-top:1px solid #303036;padding-top:14px}
      .agy-group-heading{justify-content:space-between}.agy-row{justify-content:space-between;border:1px solid #303036;border-radius:8px;padding:12px;margin-top:8px;background:#202024}
      .agy-row-info{flex:1;min-width:150px;overflow-wrap:anywhere}.agy-row[data-enabled="false"] .agy-row-info{opacity:.55}
      #agy-custom-models-section .agy-btn,#agy-modal-overlay .agy-btn{appearance:none;font:inherit;color:#e4e4e7;background:#27272c;border:1px solid #414149;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
      #agy-custom-models-section .agy-primary,#agy-modal-overlay .agy-primary{background:#e4e4e7;color:#18181b;border-color:#e4e4e7;font-weight:600}
      #agy-custom-models-section .agy-btn:hover,#agy-modal-overlay .agy-btn:hover{filter:brightness(1.12)}
      #agy-custom-models-section .agy-btn:disabled,#agy-modal-overlay .agy-btn:disabled{opacity:.5;cursor:wait}
      #agy-custom-models-section :focus-visible,#agy-modal-overlay :focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
      .agy-status{color:#86efac;font-size:12px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}.agy-status:empty{display:none}.agy-error{color:#fca5a5}
      .agy-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;min-width:0;color:#a1a1aa}
      #agy-custom-models-section input,#agy-modal-overlay input,#agy-modal-overlay select,#agy-modal-overlay textarea{font:inherit;width:100%;background:#25252a;border:1px solid #414149;border-radius:6px;color:#fafafa;padding:8px 10px;min-width:0}
      #agy-modal-overlay textarea{font-family:ui-monospace,monospace;resize:vertical}#agy-modal-overlay input[type=checkbox]{width:auto;accent-color:#a78bfa}
      #agy-modal-overlay{position:fixed;inset:0;z-index:999999;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px}
      #agy-modal-card{width:680px;max-width:100%;max-height:90vh;overflow:auto;background:#18181b;border:1px solid #414149;border-radius:12px;padding:24px;box-shadow:0 24px 80px #0008}
      .agy-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.agy-discovery{max-height:240px;overflow:auto;margin:12px 0}
      .agy-choice{display:flex;gap:10px;align-items:center;padding:7px 0;overflow-wrap:anywhere}.agy-choice span{min-width:0}
      #agy-modal-overlay details{border:1px solid #303036;border-radius:8px;margin:12px 0;padding:12px}#agy-modal-overlay summary{cursor:pointer;margin-bottom:10px;font-weight:500}
      .agy-fleet{margin:18px 0;border:1px solid #303036;border-radius:10px;padding:14px;min-width:0}.agy-fleet-table{width:100%;border-collapse:separate;border-spacing:0 12px;text-align:left;table-layout:fixed}.agy-fleet-table td{padding:0}.agy-fleet-card{background:#202024;border:1px solid #3f3f46;border-radius:10px;padding:16px;min-width:0}.agy-fleet-card-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.agy-fleet-card-header .agy-actions{margin:0}.agy-fleet-label{font-size:14px;font-weight:600;overflow-wrap:anywhere}.agy-fleet-pools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;margin-top:14px}.agy-fleet-pool{border:1px solid #303036;border-radius:8px;padding:12px;background:#18181b;min-width:0}.agy-fleet-pool .agy-actions{margin-bottom:0}.agy-fleet-account-state{margin-top:5px}.agy-pool-badge{display:inline-block;padding:2px 6px;border-radius:5px;background:#27272c;color:#a1a1aa;font-size:11px}.agy-pool-preferred,.agy-plan-pro{color:#86efac}.agy-pool-disabled{color:#fca5a5}.agy-fleet-quotas{display:grid;gap:10px;margin:12px 0}.agy-quota-group{display:grid;gap:8px}.agy-quota-group-title{font-size:11px;font-weight:600;color:#d4d4d8}.agy-quota-bucket{min-width:0}.agy-quota-heading{display:flex;justify-content:space-between;gap:8px;font-size:12px;flex-wrap:wrap}.agy-quota-bucket progress{display:block;width:100%;height:7px;margin:5px 0;accent-color:#86efac}.agy-quota-bucket[data-exhausted="true"] progress{accent-color:#f87171}.agy-quota-bucket[data-exhausted="true"] .agy-quota-value{color:#fca5a5}.agy-quota-reset{font-size:11px;color:#a1a1aa}.agy-fleet-fallback{display:flex;align-items:center;gap:8px;font-size:12px}.agy-fleet-fallback input{width:auto!important;accent-color:#86efac}.agy-fleet-details[hidden]{display:none}
      #agy-fleet-target-pool{font:inherit;color:#fafafa;background:#25252a;border:1px solid #414149;border-radius:6px;padding:6px;max-width:240px}#agy-fleet-target-pool option{background:#25252a;color:#fafafa}
      .agy-model-search-box{padding:6px 8px}.agy-model-search-input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid #52525b;border-radius:5px;padding:6px}.agy-model-no-results{padding:8px;color:#a1a1aa;font-size:12px}
      @media(max-width:600px){.agy-grid{grid-template-columns:1fr}#agy-modal-card{padding:16px}.agy-row .agy-actions{width:100%}}
    `;
    document.head.append(style);
  }
  function openModal(title: string): { body: HTMLElement; status: HTMLElement; close: () => void } {
    cancelModalOperation?.();
    cancelModalOperation = undefined;
    document.getElementById('agy-modal-overlay')?.remove();
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = element('div');
    overlay.id = 'agy-modal-overlay';
    const card = element('div');
    card.id = 'agy-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'agy-modal-title');
    const header = element('div', 'agy-toolbar');
    const heading = element('h2', '', t(title));
    heading.id = 'agy-modal-title';
    const close = () => {
      if (!overlay.isConnected) return;
      cancelModalOperation?.();
      cancelModalOperation = undefined;
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    header.append(heading, button('Close', close));
    const body = element('div');
    const status = statusNode();
    card.append(header, body, status);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        card.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,summary'),
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    document.body.append(overlay);
    header.querySelector('button')?.focus();
    return { body, status, close };
  }

  function createGoogleAccountPanel(
    parent: HTMLElement,
    initialAccounts: GoogleAccountEntry[],
    modelName?: string,
  ): () => GoogleAccountEntry[] {
    let accounts = initialAccounts.map((account) => ({ ...account }));
    const locallyEdited = new Set<string>();
    let accountOperationAttempt = 0;
    let accountOperationPending = false;
    const panel = element('details');
    panel.open = true;
    panel.append(element('summary', '', 'Google accounts'));
    panel.append(
      element(
        'p',
        'agy-muted',
        'Add up to 50 accounts you own using Antigravity sign-in, your Desktop OAuth client, or a credential file. Save the model to retain changes. Existing secrets stay masked. Prepare account checks the Cloud Code project and may activate the available free tier.',
      ),
    );
    const list = element('div');
    list.id = 'agy-google-accounts-list';
    const editor = element('div');
    const status = statusNode();
    const randomId = () => `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const addAccount = (account: GoogleAccountEntry) => {
      if (!account.id || (!account.refreshToken && !account.accessToken))
        throw new Error('An account needs an ID and a refresh token or access token.');
      if (account.refreshToken && !account.clientId)
        throw new Error('An OAuth client ID is required with a refresh token.');
      const index = accounts.findIndex((value) => value.id === account.id);
      if (index < 0) {
        if (accounts.length >= 50) throw new Error('A model can contain at most 50 Google accounts.');
        accounts.push(account);
      } else accounts[index] = account;
      locallyEdited.add(account.id);
      renderAccounts();
    };
    function editAccount(account?: GoogleAccountEntry): void {
      editor.replaceChildren();
      editor.append(element('h3', '', account ? 'Edit account' : 'Add account credentials'));
      const accountGrid = element('div', 'agy-grid');
      const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || randomId());
      const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || '');
      const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
      const clientSecret = field(
        accountGrid,
        'OAuth client secret (if required)',
        'agy-account-client-secret',
        account?.clientSecret || '',
        'password',
      );
      const refresh = field(
        accountGrid,
        'Refresh token',
        'agy-account-refresh-token',
        account?.refreshToken || '',
        'password',
      );
      const access = field(
        accountGrid,
        'Access token (optional with refresh token)',
        'agy-account-access-token',
        account?.accessToken || '',
        'password',
      );
      const expires = field(
        accountGrid,
        'Access token expiry (Unix milliseconds)',
        'agy-account-expires-at',
        account?.expiresAt != null ? String(account.expiresAt) : '',
        'number',
      );
      const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
      editor.append(accountGrid);
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Apply account',
          () => {
            const accountId = id.value.trim();
            if (account && accountId !== account.id && accounts.some((value) => value.id === accountId))
              throw new Error('That account ID already exists.');
            const updated: GoogleAccountEntry = {
              id: accountId,
              label: label.value.trim(),
              clientId: clientId.value.trim(),
              clientSecret: clientSecret.value.trim(),
              refreshToken: refresh.value.trim(),
              accessToken: access.value.trim(),
              expiresAt: readNumber(expires, 'Token expiry', 1),
              project: project.value.trim(),
              authMode: account?.authMode,
              cloudCodeEndpoint: account?.cloudCodeEndpoint,
              enabled: account?.enabled !== false,
            };
            // IDs bind masked secrets to their stored record, so changing an existing ID requires fresh credentials.
            if (
              account &&
              accountId !== account.id &&
              [updated.refreshToken, updated.accessToken, updated.clientSecret].some((value) => value?.includes('***'))
            )
              throw new Error('Keep the account ID unchanged when using masked credentials.');
            addAccount(updated);
            if (account && accountId !== account.id) accounts = accounts.filter((value) => value.id !== account.id);
            editor.replaceChildren();
            renderAccounts();
            setStatus(status, 'Account updated. Save the model to keep these changes.');
          },
          status,
        ),
        button('Cancel account edit', () => editor.replaceChildren(), status),
      );
      editor.append(actions);
    }
    function renderAccounts(): void {
      list.replaceChildren();
      if (!accounts.length) list.append(element('p', 'agy-muted', 'No Google accounts configured.'));
      for (const account of accounts) {
        const row = element('div', 'agy-row');
        const info = element('div', 'agy-row-info');
        info.append(
          element('strong', '', account.label || account.id),
          element(
            'div',
            'agy-muted',
            `${account.id} · ${account.enabled === false ? 'Disabled' : 'Enabled'}${account.project ? ` · ${account.project}` : ''}`,
          ),
        );
        const actions = element('div', 'agy-actions');
        actions.append(
          button('Edit account', () => editAccount(account), status),
          button(
            account.enabled === false ? 'Enable account' : 'Disable account',
            () => {
              account.enabled = account.enabled === false;
              renderAccounts();
            },
            status,
          ),
          button(
            'Test account',
            async () => {
              setStatus(status, 'Checking account access and quota…');
              const result = await ipcRenderer.invoke(
                'storage:google-test-account',
                modelName && !locallyEdited.has(account.id)
                  ? { modelName, accountId: account.id }
                  : { account, ...(modelName ? { modelName } : {}) },
              );
              requireSuccess(result);
              setStatus(
                status,
                result.message ||
                  (result.quota
                    ? `Account verified. Quota: ${JSON.stringify(result.quota)}`
                    : 'Account verified. Generation was not tested.'),
              );
            },
            status,
          ),
          button(
            'Prepare account',
            async () => {
              if (accountOperationPending)
                throw new Error('Wait for the current Google account operation or cancel it.');
              accountOperationPending = true;
              const attempt = ++accountOperationAttempt;
              const cancel = () => {
                accountOperationAttempt++;
                void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
              };
              cancelModalOperation = cancel;
              try {
                setStatus(status, 'Preparing account access and Cloud Code project…');
                const result = await ipcRenderer.invoke('storage:google-account-prepare', {
                  ...(modelName && !locallyEdited.has(account.id)
                    ? { modelName, accountId: account.id }
                    : { account, ...(modelName ? { modelName } : {}) }),
                  allowOnboard: true,
                });
                if (!panel.isConnected || accountOperationAttempt !== attempt) return;
                requireSuccess(result);
                if (!accounts.some((value) => value.id === account.id)) return;
                if (!result.account || result.account.id !== account.id)
                  throw new Error('Account preparation did not return the selected account.');
                addAccount({ ...account, ...(result.account as GoogleAccountEntry) });
                setStatus(
                  status,
                  result.message ||
                    'Account prepared. Save the model to retain the project. Generation was not tested.',
                );
              } finally {
                accountOperationPending = false;
                if (cancelModalOperation === cancel) cancelModalOperation = undefined;
              }
            },
            status,
          ),
          button(
            'Remove account',
            () => {
              accounts = accounts.filter((value) => value.id !== account.id);
              locallyEdited.delete(account.id);
              renderAccounts();
            },
            status,
          ),
        );
        row.append(info, actions);
        list.append(row);
      }
    }
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Add account', () => editAccount(), status),
      button(
        'Pool status',
        async () => {
          const result = await ipcRenderer.invoke('storage:google-pool-status');
          if (result?.success === false) requireSuccess(result);
          setStatus(status, JSON.stringify(result, null, 2));
        },
        status,
      ),
    );
    const login = element('details');
    login.append(element('summary', '', 'Sign in with Google'));
    const loginMode = selectField(
      login,
      'Sign-in method',
      'agy-google-login-auth-mode',
      [
        ['antigravity', 'Antigravity account'],
        ['custom', 'My Desktop OAuth client'],
      ],
      'antigravity',
    );
    const loginHelp = element('p', 'agy-muted');
    login.append(loginHelp);
    const loginLabel = field(login, 'Account label', 'agy-google-login-label');
    const loginClient = field(login, 'Desktop OAuth client ID', 'agy-google-login-client-id');
    const loginSecret = field(
      login,
      'OAuth client secret (if required)',
      'agy-google-login-client-secret',
      '',
      'password',
    );
    const updateLoginMode = () => {
      const native = loginMode.value === 'antigravity';
      loginClient.closest('label')!.hidden = native;
      loginSecret.closest('label')!.hidden = native;
      loginHelp.textContent = native
        ? 'Sign in through your browser using the installed Antigravity app’s OAuth client. This prepares your Cloud Code project and may activate the available free tier. A recognized Antigravity installation is required. Repeat for each account, then save the model. Generation must be tested separately.'
        : 'Enter a Desktop OAuth client from your Google Cloud project. Your project and account must have access to the configured Cloud Code service. Repeat Sign in with Google for each account, then save the model.';
    };
    loginMode.addEventListener('change', updateLoginMode);
    updateLoginMode();
    const loginActions = element('div', 'agy-actions');
    loginActions.append(
      button(
        'Sign in with Google',
        async () => {
          const authMode = loginMode.value === 'custom' ? 'custom' : 'antigravity';
          if (authMode === 'custom' && !loginClient.value.trim())
            throw new Error('Enter your Desktop OAuth client ID.');
          if (accountOperationPending) throw new Error('Wait for the current Google account operation or cancel it.');
          accountOperationPending = true;
          const attempt = ++accountOperationAttempt;
          const cancel = () => {
            accountOperationAttempt++;
            void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
          };
          cancelModalOperation = cancel;
          for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = true;
          setStatus(
            status,
            authMode === 'antigravity'
              ? 'Complete consent in your browser, then wait for account preparation. Browser login expires after two minutes.'
              : 'Complete consent in your browser. This login expires after two minutes.',
          );
          try {
            const result = await ipcRenderer.invoke('storage:google-login', {
              authMode,
              ...(authMode === 'custom'
                ? { clientId: loginClient.value.trim(), clientSecret: loginSecret.value.trim() || undefined }
                : {}),
              label: loginLabel.value.trim() || undefined,
            });
            if (!panel.isConnected || accountOperationAttempt !== attempt) return;
            requireSuccess(result);
            if (!result.account) throw new Error('Google login did not return an account.');
            addAccount(result.account as GoogleAccountEntry);
            loginSecret.value = '';
            setStatus(
              status,
              'Account authorized. Save the model within 10 minutes to retain it; otherwise sign in again. Use Test account to check service access and quota, then Test generation to verify a model response.',
            );
          } finally {
            accountOperationPending = false;
            for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = false;
            if (cancelModalOperation === cancel) cancelModalOperation = undefined;
          }
        },
        status,
      ),
      button(
        'Cancel Google login',
        async () => {
          accountOperationAttempt++;
          requireSuccess(await ipcRenderer.invoke('storage:google-login-cancel'));
          cancelModalOperation = undefined;
          setStatus(status, 'Google login cancelled.');
        },
        status,
      ),
    );
    login.append(loginActions);
    const importer = element('details');
    importer.append(element('summary', '', 'Import account credentials'));
    importer.append(
      element(
        'p',
        'agy-muted',
        'Import your own authorized_user JSON, an account object, or an accounts array. Importing does not open a browser or make network requests.',
      ),
    );
    const accountJson = jsonField(importer, 'Account JSON', 'agy-google-account-json', undefined);
    const file = field(importer, 'Credential JSON file', 'agy-google-account-file', '', 'file');
    file.accept = '.json,application/json';
    file.addEventListener('change', async () => {
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 512 * 1024) throw new Error('Account files must be smaller than 512 KB.');
        accountJson.value = await selected.text();
      } catch (error) {
        setStatus(status, String(error), true);
      }
    });
    importer.append(
      button(
        'Import accounts',
        () => {
          let data: unknown;
          try {
            data = JSON.parse(accountJson.value);
          } catch {
            throw new Error('Account credentials must be valid JSON.');
          }
          const root = data as { accounts?: unknown[]; googleAccounts?: unknown[] };
          const values = Array.isArray(data) ? data : root?.accounts || root?.googleAccounts || [data];
          if (!Array.isArray(values) || !values.length || values.length + accounts.length > 50)
            throw new Error('Import between 1 and 50 accounts.');
          const incoming = values.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Each account must be a JSON object.');
            const entry = value as Record<string, unknown>;
            const text = (key: string, alternate = key): string => String(entry[key] || entry[alternate] || '');
            const account: GoogleAccountEntry = {
              id: text('id') || randomId(),
              label: text('label', 'accountEmail') || 'Imported account',
              refreshToken: text('refreshToken', 'refresh_token'),
              accessToken: text('accessToken', 'access_token'),
              clientId: text('clientId', 'client_id'),
              clientSecret: text('clientSecret', 'client_secret'),
              project: text('project', 'quota_project_id'),
              ...(entry.authMode === 'custom' || entry.authMode === 'antigravity' ? { authMode: entry.authMode } : {}),
              ...(entry.cloudCodeEndpoint ? { cloudCodeEndpoint: text('cloudCodeEndpoint') } : {}),
              enabled: entry.enabled !== false,
              ...(entry.expiresAt != null ? { expiresAt: Number(entry.expiresAt) } : {}),
            };
            if (!account.refreshToken && !account.accessToken)
              throw new Error('An imported account must contain a refresh token or access token.');
            if (account.refreshToken && !account.clientId)
              throw new Error('An imported refresh token requires its OAuth client ID.');
            return account;
          });
          for (const account of incoming) addAccount(account);
          accountJson.value = '';
          file.value = '';
          setStatus(status, `Imported ${incoming.length} accounts. Save the model to encrypt and retain them.`);
        },
        status,
      ),
    );
    panel.append(list, actions, editor, login, importer, status);
    parent.append(panel);
    renderAccounts();
    return () => accounts.map((account) => ({ ...account }));
  }
  const nonSettingsContent =
    '#agy-custom-models-section,#agy-modal-overlay,button,nav,[role="tablist"],article,[role="article"],pre,code,' +
    '[data-testid="conversation-view"],[data-testid="autoscroll-viewport"],[role="log"]';
  function isSettingsContent(node: HTMLElement): boolean {
    if (node.closest(nonSettingsContent)) return false;
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function findRefreshButton(root: ParentNode): HTMLButtonElement | null {
    return (
      Array.from(root.querySelectorAll('button')).find(
        (node) =>
          !node.closest('#agy-custom-models-section') &&
          isSettingsContent(node.parentElement || node) &&
          (node.textContent?.trim() === 'Refresh' ||
            node.textContent?.trim() === '刷新' ||
            /refresh quota|刷新配额|刷新用量/i.test(`${node.getAttribute('aria-label') || ''} ${node.title || ''}`)),
      ) || null
    );
  }
  async function modelsChanged(): Promise<void> {
    const restore = captureScrollPosition(document.getElementById('agy-custom-models-section') || document.body);
    fleetEpoch++;
    quotaCache.clear();
    customModelsCache.ts = 0;
    await renderCustomModelsList();
    const mount = findSettingsMount();
    if (mount) findRefreshButton(mount)?.click();
    restore();
  }
  function uniqueName(base: string): string {
    let name = base,
      index = 2;
    while (modelList.some((model) => model.name === name)) name = `${base}-${index++}`;
    return name;
  }
  function captureScrollPosition(node: HTMLElement): () => void {
    const positions = new Map<HTMLElement, { top: number; left: number }>();
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
      positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
    const scrollingElement = document.scrollingElement as HTMLElement | null;
    if (scrollingElement && !positions.has(scrollingElement))
      positions.set(scrollingElement, { top: scrollingElement.scrollTop, left: scrollingElement.scrollLeft });
    return () => {
      for (const [element, position] of positions) {
        if (!element.isConnected) continue;
        element.scrollTop = position.top;
        element.scrollLeft = position.left;
      }
    };
  }
  function openDeleteModelModal(model: CustomModelEntry): void {
    const { body, status, close } = openModal('Delete model');
    body.append(
      element('p', '', `Delete “${model.displayName || model.name}”?`),
      element('p', 'agy-muted', 'This removes the saved model configuration from this app.'),
    );
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Cancel', close),
      button(
        'Delete model',
        async () => {
          const visibleRows = Array.from(document.querySelectorAll<HTMLElement>('#agy-custom-models-content [data-model-name]'));
          const deletedIndex = visibleRows.findIndex((row) => row.dataset.modelName === model.name);
          const adjacentNames = [...visibleRows.slice(deletedIndex + 1), ...visibleRows.slice(0, deletedIndex).reverse()]
            .map((row) => row.dataset.modelName);
          setStatus(status, 'Deleting model…');
          requireSuccess(await storageAPI.deleteCustomModel(model.name));
          // The user may have closed this dialog while storage was updating.
          const dialogStillOpen = body.isConnected;
          if (dialogStillOpen) close();
          const focusAfterClose = document.activeElement;
          await modelsChanged();
          if (dialogStillOpen && !document.getElementById('agy-modal-overlay') &&
            (document.activeElement === document.body || document.activeElement === focusAfterClose)) {
            const remainingRows = Array.from(document.querySelectorAll<HTMLElement>('#agy-custom-models-content [data-model-name]'));
            const adjacentRow = adjacentNames.map((name) => remainingRows.find((row) => row.dataset.modelName === name)).find(Boolean);
            const nextFocus = Array.from(adjacentRow?.querySelectorAll<HTMLButtonElement>('button') || [])
              .find((button) => button.textContent === 'Delete' || button.textContent === '删除') || document.getElementById('agy-add-model');
            nextFocus?.focus({ preventScroll: true });
          }
        },
        status,
        true,
      ),
    );
    body.append(actions);
  }
  const quotaCache = new Map<string, { quota?: AccountQuota; error?: string; at: number }>();
  let fleetEpoch = 0;
  let fleetBusy = false;
  let fleetError = '';
  let fleetCollapsed = false;
  let fleetTargetPool = '';
  try { fleetCollapsed = localStorage.getItem('agy_google_fleet_collapsed') === 'true'; } catch {}
  let fleetRefreshing = false;
  let fleetTimer: ReturnType<typeof setInterval> | undefined;
  function fleetMembers(models: CustomModelEntry[]) {
    const members: { account: GoogleAccountEntry; owner: CustomModelEntry }[] = [];
    for (const model of models) {
      if (model.provider !== 'google-cloudcode' || !Array.isArray(model.googleAccounts)) continue;
      for (const account of model.googleAccounts as GoogleAccountEntry[]) {
        if (!account?.id) continue;
        members.push({ account, owner: model });
      }
    }
    return members;
  }
  function fleetAccounts(models: CustomModelEntry[]) {
    const rows = new Map<string, { identity: string; members: ReturnType<typeof fleetMembers> }>();
    for (const member of fleetMembers(models)) {
      const { owner, account } = member;
      const email = (account.email || quotaCache.get(quotaKey(owner, account))?.quota?.email)?.trim();
      // Only a known email identifies a shared account. Unknown memberships stay
      // separate, and grouping never replaces the original owner/account used by actions.
      const key = email ? `email:${email.toLowerCase()}` : `member:${owner.name}:${account.id}`;
      const row = rows.get(key);
      if (row) row.members.push(member);
      else rows.set(key, { identity: email || account.label || account.id, members: [member] });
    }
    return [...rows.values()];
  }
  function quotaKey(model: CustomModelEntry, account: GoogleAccountEntry) {
    return JSON.stringify([model.name, model.apiUrl, model.externalModelName, account.id, account.email, account.clientId, account.project, account.authMode, account.cloudCodeEndpoint]);
  }
  async function connectFleetAccount(modelName: string, replaceAccountId?: string): Promise<void> {
    const { body, status, close } = openModal(replaceAccountId ? 'Reconnect Google account' : 'Add Google account');
    body.append(element('p', 'agy-muted', `Complete Google sign-in in your browser. The account is saved to ${modelName}.`));
    cancelModalOperation = () => { void ipcRenderer.invoke('storage:google-login-cancel'); };
    setStatus(status, 'Waiting for Google sign-in…');
    try {
      const result = await ipcRenderer.invoke('storage:google-login', { authMode: 'antigravity' }) as ActionResult & { account?: GoogleAccountEntry };
      if (!body.isConnected) return;
      requireSuccess(result);
      if (!result.account) throw new Error('Google did not return an account.');
      requireSuccess(await ipcRenderer.invoke('storage:google-link-account', { modelName, accountId: result.account.id, ...(replaceAccountId ? { replaceAccountId } : {}) }));
      quotaCache.clear();
      cancelModalOperation = undefined;
      close();
      await modelsChanged();
    } catch (error) {
      if (body.isConnected) setStatus(status, error instanceof Error ? error.message : String(error), true);
    }
  }
  function removeFleetAccount(account: GoogleAccountEntry, modelName: string) {
    const { body, status, close } = openModal('Remove Google account');
    body.append(element('p', '', `Remove ${account.email || account.label || account.id} from ${modelName}? This model will be disabled if no enabled account remains. Other model pools and your IDE login are preserved.`));
    body.append(button('Remove account', async () => {
      requireSuccess(await ipcRenderer.invoke('storage:google-remove-account', { modelName, accountId: account.id }));
      quotaCache.clear();
      close();
      await modelsChanged();
    }, status), button('Cancel', close));
  }
  async function runFleetAction(action: () => Promise<void>): Promise<void> {
    if (fleetBusy) throw new Error('Wait for the current account change to finish.');
    fleetBusy = true;
    fleetError = '';
    renderGoogleFleet();
    const disabledStates = new Map<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, boolean>();
    const roots = document.querySelectorAll<HTMLElement>('#agy-custom-models-section, #agy-modal-overlay');
    for (const root of roots) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')) {
        disabledStates.set(control, control.disabled);
        control.disabled = true;
      }
    }
    try {
      await action();
    } catch (error) {
      fleetError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Keep the lock until fresh records replace the old model/group closures.
      // The button helper also guards controls created during an async rerender.
      try {
        await modelsChanged();
      } finally {
        fleetBusy = false;
        for (const [control, wasDisabled] of disabledStates) {
          if (control.isConnected) control.disabled = wasDisabled;
        }
        renderGoogleFleet();
        void refreshFleetQuotas();
      }
    }
  }
  async function updateFleetAccounts(
    members: ReturnType<typeof fleetMembers>,
    update: (account: GoogleAccountEntry) => GoogleAccountEntry,
    updateAvailability = false,
  ): Promise<void> {
    // Read current records and save each owner once. A card is a display grouping;
    // its members retain their original IDs, credentials, projects and endpoints.
    const current = await storageAPI.getCustomModels();
    for (const owner of current) {
      const selected = new Set(members.filter((m) => m.owner.name === owner.name).map((m) => m.account.id));
      if (!selected.size || !Array.isArray(owner.googleAccounts)) continue;
      const accounts = owner.googleAccounts as GoogleAccountEntry[];
      const updated = accounts.map((account) => selected.has(account.id) ? update(account) : account);
      const hadEnabled = accounts.some((account) => account.enabled !== false);
      const hasEnabled = updated.some((account) => account.enabled !== false);
      requireSuccess(await storageAPI.saveCustomModel({
        ...owner,
        googleAccounts: updated,
        ...(updateAvailability ? { enabled: hasEnabled ? (hadEnabled ? owner.enabled : true) : false } : {}),
      }));
    }
  }
  function editFleetLabel(identity: string, members: ReturnType<typeof fleetMembers>): void {
    const { body, status, close } = openModal('Edit account label');
    body.append(element('p', 'agy-muted', `Update the label for ${identity}. Use a model pool's account editor to change its credentials or project.`));
    const label = field(body, 'Account label', 'agy-fleet-account-label', members[0]?.account.label || '');
    body.append(button('Save account label', async () => {
      await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, label: label.value.trim() })));
      close();
    }, status, true), button('Cancel', close));
  }
  function removeFleetMemberships(identity: string, members: ReturnType<typeof fleetMembers>): void {
    const { body, status, close } = openModal('Remove account from fleet');
    body.append(element('p', '', `Remove ${identity} from ${members.length} assigned model pool${members.length === 1 ? '' : 's'}?`),
      element('p', 'agy-muted', 'Model definitions and other accounts are preserved. Pools without enabled accounts will be disabled.'));
    body.append(button('Remove from all pools', async () => {
      await runFleetAction(async () => {
        for (const { owner, account } of members) {
          requireSuccess(await ipcRenderer.invoke('storage:google-remove-account', { modelName: owner.name, accountId: account.id }));
        }
      });
      close();
    }, status), button('Cancel', close));
  }
  function relativeQuotaReset(value: string): string {
    const diff = Date.parse(value) - Date.now();
    if (!Number.isFinite(diff)) return '';
    if (isChinese()) {
      if (diff <= 0) return '已到重置时间 · 请刷新配额';
      const minutes = Math.ceil(diff / 60_000);
      if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天 ${Math.floor((minutes % 1440) / 60)}小时后重置`;
      if (minutes >= 60) return `${Math.floor(minutes / 60)}小时 ${minutes % 60}分钟后重置`;
      return `${minutes}分钟后重置`;
    }
    if (diff <= 0) return 'Reset due · refresh quota';
    const minutes = Math.ceil(diff / 60_000);
    if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
    if (minutes >= 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `Resets in ${minutes}m`;
  }
  function renderPoolQuota(quota: HTMLElement, cached: ReturnType<typeof quotaCache.get>): void {
    if (cached?.quota?.planTier) {
      const tier = cached.quota.planTier;
      quota.append(element('span', `agy-pool-badge${/\bpro\b/i.test(tier) ? ' agy-plan-pro' : ''}`, tier));
    }
    if (cached?.error) {
      quota.append(element('div', 'agy-status agy-error', cached.error));
      return;
    }
    if (!cached) {
      quota.append(element('span', 'agy-muted', 'Loading quota…'));
      return;
    }
    // The flat snapshot contains every parsed bucket, including groups. Never
    // deduplicate across projects, model pools, or distinct model buckets.
    const buckets = cached.quota?.buckets || [];
    if (!buckets.length) {
      quota.append(element('span', 'agy-muted', 'Quota unavailable — Google returned no buckets.'));
      return;
    }
    const groups = new Map<string, QuotaBucket[]>();
    for (const bucket of buckets) {
      const title = bucket.groupName || 'Reported quota';
      groups.set(title, [...(groups.get(title) || []), bucket]);
    }
    for (const [title, buckets] of groups) {
      const group = element('div', 'agy-quota-group');
      group.append(element('div', 'agy-quota-group-title', title));
      for (const bucket of buckets) {
        const block = element('div', 'agy-quota-bucket');
        const fraction = bucket.remainingFraction;
        const known = typeof fraction === 'number' && Number.isFinite(fraction);
        block.dataset.exhausted = String(known && fraction <= 0);
        const title = bucket.displayName || ({ weekly: 'Weekly limit', five_hour: 'Five-hour limit', daily: 'Daily limit' } as Record<string, string>)[bucket.id] || bucket.id;
        const heading = element('div', 'agy-quota-heading');
        heading.append(element('span', 'agy-muted', t(title)),
          element('span', 'agy-quota-value', known ? (isChinese() ? `剩余 ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}% remaining`) : t('Remaining quota unknown', '剩余配额未知')));
        block.append(heading);
        if (known) {
          const progress = element('progress');
          progress.max = 1;
          progress.value = Math.max(0, Math.min(1, fraction));
          progress.setAttribute('aria-label', `${bucket.groupName || ''} ${title} remaining quota`.trim());
          block.append(progress);
        }
        if (bucket.resetTime) {
          const text = relativeQuotaReset(bucket.resetTime);
          if (text) {
            const reset = element('div', 'agy-quota-reset', text);
            reset.title = new Date(bucket.resetTime).toLocaleString();
            block.append(reset);
          }
        }
        group.append(block);
      }
      quota.append(group);
    }
  }
  async function refreshFleetQuotas(force = false): Promise<void> {
    if (fleetRefreshing || fleetBusy) return;
    const container = document.getElementById('agy-google-account-pool-section');
    if (!container?.isConnected || container.hidden) return;
    const members = fleetMembers(modelList).filter(({ owner, account }) =>
      force || Date.now() - (quotaCache.get(quotaKey(owner, account))?.at || 0) >= 120_000);
    if (!members.length) return;
    const epoch = fleetEpoch;
    fleetRefreshing = true;
    renderGoogleFleet();
    try {
      // A small sequential queue avoids a login or quota request burst on large fleets.
      for (const { account, owner } of members) {
        if (!container.isConnected || fleetEpoch !== epoch || fleetBusy) break;
        const key = quotaKey(owner, account);
        if (!force && Date.now() - (quotaCache.get(key)?.at || 0) < 120_000) continue;
        try {
          const result = await ipcRenderer.invoke('storage:google-test-account', { modelName: owner.name, accountId: account.id }) as ActionResult & { quota?: AccountQuota };
          requireSuccess(result);
          if (fleetEpoch === epoch) quotaCache.set(key, { quota: result.quota, at: Date.now() });
        } catch (error) {
          if (fleetEpoch === epoch) quotaCache.set(key, { error: error instanceof Error ? error.message : String(error), at: Date.now() });
        }
      }
    } finally {
      fleetRefreshing = false;
      if (container.isConnected) renderGoogleFleet();
      if (fleetEpoch !== epoch) void refreshFleetQuotas();
    }
  }
  function renderGoogleFleet(): void {
    const container = document.getElementById('agy-google-account-pool-section');
    if (!container) return;
    const restoreScroll = captureScrollPosition(container);
    const rows = fleetAccounts(modelList);
    const hasGoogleModels = modelList.some((model) => model.provider === 'google-cloudcode');
    container.hidden = !hasGoogleModels;
    if (!hasGoogleModels) {
      container.replaceChildren();
      restoreScroll();
      return;
    }
    const keys = new Set(fleetMembers(modelList).map(({ account, owner }) => quotaKey(owner, account)));
    for (const key of quotaCache.keys()) if (!keys.has(key)) quotaCache.delete(key);
    const header = element('div', 'agy-toolbar');
    const collapse = button(isChinese() ? `${fleetCollapsed ? '▸' : '▾'} Google 账号集群 · ${rows.length} 个账号` : `${fleetCollapsed ? '▸' : '▾'} Google account fleet · ${rows.length} account${rows.length === 1 ? '' : 's'}`, () => {
      fleetCollapsed = !fleetCollapsed;
      try { localStorage.setItem('agy_google_fleet_collapsed', String(fleetCollapsed)); } catch {}
      renderGoogleFleet();
      document.getElementById('agy-fleet-collapse')?.focus({ preventScroll: true });
    });
    collapse.id = 'agy-fleet-collapse';
    collapse.setAttribute('aria-expanded', String(!fleetCollapsed));
    collapse.setAttribute('aria-controls', 'agy-fleet-details');
    header.append(collapse);
    const actions = element('div', 'agy-actions');
    const targetPool = element('select');
    targetPool.id = 'agy-fleet-target-pool';
    targetPool.setAttribute('aria-label', 'Pool for new Google account');
    for (const model of modelList.filter((model) => model.provider === 'google-cloudcode')) {
      const option = element('option', '', model.displayName || model.name); option.value = model.name; targetPool.append(option);
    }
    if (Array.from(targetPool.options).some((option) => option.value === fleetTargetPool)) targetPool.value = fleetTargetPool;
    targetPool.onchange = () => { fleetTargetPool = targetPool.value; };
    actions.append(targetPool);
    const add = button('+ Add Account', () => connectFleetAccount(targetPool.value));
    add.id = 'agy-pool-add-account-btn';
    const refresh = button(fleetRefreshing ? 'Refreshing quotas…' : 'Refresh quotas', () => refreshFleetQuotas(true));
    refresh.id = 'agy-fleet-refresh';
    refresh.disabled = fleetRefreshing;
    actions.append(add, refresh);
    header.append(actions);
    const wrap = element('div', 'agy-fleet-details');
    wrap.id = 'agy-fleet-details';
    wrap.hidden = fleetCollapsed;
    const fallback = element('label', 'agy-fleet-fallback');
    const fallbackInput = element('input');
    fallbackInput.type = 'checkbox';
    fallbackInput.id = 'agy-fleet-native-failover';
    const googleModels = modelList.filter((model) => model.provider === 'google-cloudcode');
    const enabledFallbacks = googleModels.filter((model) => (model.googlePool as { nativeFailoverEnabled?: boolean } | undefined)?.nativeFailoverEnabled === true).length;
    fallbackInput.checked = enabledFallbacks > 0;
    fallbackInput.indeterminate = enabledFallbacks > 0 && enabledFallbacks < googleModels.length;
    fallback.append(fallbackInput, element('span', '', 'Native Google request fallback'),
      element('span', 'agy-muted', fallbackInput.indeterminate ? 'Some pools enabled' : fallbackInput.checked ? 'Enabled' : 'Disabled'));
    fallbackInput.addEventListener('change', async () => {
      const enabled = fallbackInput.checked;
      try {
        await runFleetAction(async () => {
          for (const model of await storageAPI.getCustomModels()) {
            if (model.provider !== 'google-cloudcode') continue;
            requireSuccess(await storageAPI.saveCustomModel({
              ...model, googlePool: { ...(model.googlePool as object || {}), nativeFailoverEnabled: enabled },
            }));
          }
        });
      } catch { /* runFleetAction displays the persisted result and error. */ }
    });
    wrap.append(fallback,
      element('p', 'agy-muted', 'Each model pool keeps its own credentials, project and reported quotas. Preferred accounts are used when eligible; unknown limits are not available credit.'));
    const table = element('table', 'agy-fleet-table');
    table.setAttribute('aria-label', 'Google account fleet');
    const tbody = element('tbody');
    for (const { identity: accountIdentity, members } of rows) {
      const row = element('tr');
      row.dataset.accountIdentity = accountIdentity;
      const cell = element('td');
      const card = element('article', 'agy-fleet-card');
      const cardHeader = element('div', 'agy-fleet-card-header');
      const identity = element('div');
      identity.append(element('div', 'agy-fleet-label', accountIdentity),
        element('div', 'agy-muted', isChinese() ? `${members.length} 个模型池` : `${members.length} model pool${members.length === 1 ? '' : 's'}`));
      const labels = [...new Set(members.map(({ account }) => account.label?.trim()).filter((label): label is string => !!label && label !== accountIdentity))];
      if (labels.length) identity.append(element('div', 'agy-muted', labels.join(' · ')));
      const activeCount = members.filter(({ account }) => account.enabled !== false).length;
      identity.append(element('span', `agy-fleet-account-state agy-pool-badge${activeCount === 0 ? ' agy-pool-disabled' : ''}`,
        activeCount === 0 ? 'Disabled' : activeCount === members.length ? 'Enabled' : 'Partially enabled'));
      const accountActions = element('div', 'agy-actions agy-fleet-account-actions');
      accountActions.append(
        button(activeCount ? 'Disable account' : 'Enable account', async () => {
          await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, enabled: activeCount === 0 }), true));
        }),
        button('Edit label', () => editFleetLabel(accountIdentity, members)),
        button('Remove from fleet', () => removeFleetMemberships(accountIdentity, members)),
      );
      cardHeader.append(identity, accountActions);
      card.append(cardHeader);
      const pools = element('div', 'agy-fleet-pools');
      for (const { account, owner } of members) {
        const cached = quotaCache.get(quotaKey(owner, account));
        const pool = element('section', 'agy-fleet-pool');
        pool.setAttribute('role', 'group');
        pool.setAttribute('aria-label', `${owner.displayName || owner.name} account ${account.id}`);
        pool.dataset.modelName = owner.name;
        pool.dataset.accountId = account.id;
        const poolHeading = element('div', 'agy-group-heading');
        const poolIdentity = element('div');
        poolIdentity.append(element('h3', '', owner.displayName || owner.name),
          element('div', 'agy-muted', [owner.name, `Account: ${account.id}`, account.project ? `Project: ${account.project}` : ''].filter(Boolean).join(' · ')));
        const preferred = (owner.googlePool as { preferredAccountId?: string } | undefined)?.preferredAccountId === account.id;
        const enabled = owner.enabled !== false && account.enabled !== false;
        poolHeading.append(poolIdentity, element('span', `agy-pool-badge${preferred ? ' agy-pool-preferred' : ''}`, !enabled ? 'Disabled' : preferred ? 'Preferred' : 'Automatic'));
        pool.append(poolHeading);
        const quota = element('div', 'agy-fleet-quotas');
        renderPoolQuota(quota, cached);
        const rowActions = element('div', 'agy-actions');
        const choose = button(preferred ? 'Automatic' : 'Use preferred', async () => {
          await runFleetAction(async () => {
            requireSuccess(await ipcRenderer.invoke('storage:google-select-account', { modelName: owner.name, ...(preferred ? {} : { accountId: account.id }) }));
          });
        });
        choose.disabled = !enabled;
        rowActions.append(choose, account.authMode === 'antigravity' ? button('Reconnect', () => connectFleetAccount(owner.name, account.id)) : button('Edit account', () => openModelModal(owner)), button('Remove', () => removeFleetAccount(account, owner.name)));
        pool.append(quota, rowActions);
        pools.append(pool);
      }
      card.append(pools);
      cell.append(card);
      row.append(cell);
      tbody.append(row);
    }
    table.append(tbody);
    wrap.append(table);
    const status = statusNode();
    setStatus(status, fleetError || (fleetRefreshing ? 'Checking each model pool’s quota…' : ''), !!fleetError);
    container.setAttribute('aria-busy', String(fleetBusy || fleetRefreshing));
    container.replaceChildren(header, status, wrap);
    if (fleetBusy) {
      for (const control of container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) {
        if (control !== collapse) control.disabled = true;
      }
    }
    restoreScroll();
  }

  async function renderCustomModelsList(): Promise<void> {
    const target = document.getElementById('agy-custom-models-content');
    if (!target) return;
    const version = ++renderVersion;
    try {
      const models = await storageAPI.getCustomModels();
      if (version !== renderVersion || !target.isConnected) return;
      const restoreScroll = captureScrollPosition(target);
      modelList = models;
      renderGoogleFleet();
      void refreshFleetQuotas();
      const content = document.createDocumentFragment();
      const groups = new Map<string, CustomModelEntry[]>();
      for (const model of models) {
        if (
          searchTerm &&
          !`${model.displayName} ${model.name} ${model.externalModelName} ${model.provider}`
            .toLowerCase()
            .includes(searchTerm)
        )
          continue;
        const key = `${model.provider}\n${model.apiUrl}`;
        groups.set(key, [...(groups.get(key) || []), model]);
      }
      if (!groups.size)
        content.append(
          element(
            'p',
            'agy-muted',
            models.length
              ? 'No models match this search.'
              : 'Add a provider model, discover a local server, or import a configuration to get started.',
          ),
        );
      for (const models of groups.values()) {
        const first = models[0];
        const group = element('section', 'agy-group');
        const header = element('div', 'agy-group-heading');
        const heading = element('div');
        heading.append(
          element(
            'h3',
            '',
            `${first.provider} · ${models.filter((model) => model.enabled !== false).length}/${models.length} ${t('enabled', '已启用')}`,
          ),
          element('div', 'agy-muted', first.apiUrl),
        );
        const groupStatus = statusNode();
        const actions = element('div', 'agy-actions');
        actions.append(button('Discover models', () => openModelModal(first, 'discover'), groupStatus));
        const allEnabled = models.every((model) => model.enabled !== false);
        actions.append(
          button(
            allEnabled ? 'Disable group' : 'Enable group',
            async () => {
              for (const model of models)
                requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !allEnabled }));
              await modelsChanged();
            },
            groupStatus,
          ),
        );
        header.append(heading, actions);
        group.append(header, groupStatus);
        for (const model of models) {
          const row = element('div', 'agy-row');
          row.dataset.modelName = model.name;
          row.dataset.enabled = String(model.enabled !== false);
          const info = element('div', 'agy-row-info');
          info.append(
            element('strong', '', model.displayName || model.name),
            element('div', 'agy-muted', model.externalModelName),
          );
          if (model.nativePickerAvailable === false) info.append(element('div', 'agy-muted',
            typeof model.nativePickerError === 'string' ? model.nativePickerError :
              'Not currently available in the native model picker. Direct API access remains available.'));
          const rowStatus = statusNode();
          info.append(rowStatus);
          const actions = element('div', 'agy-actions');
          actions.append(
            button(
              model.enabled === false ? 'Enable' : 'Disable',
              async () => {
                requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: model.enabled === false }));
                await modelsChanged();
              },
              rowStatus,
            ),
            button(
              'Test',
              async () => {
                setStatus(rowStatus, 'Testing…');
                const result = requireSuccess(await storageAPI.testModelConnection(model));
                setStatus(rowStatus, result.message || 'Connection successful.');
              },
              rowStatus,
            ),
            button('Test generation', () => openGenerationTest(model), rowStatus),
            button('Edit', () => openModelModal(model, 'edit'), rowStatus),
            button('Duplicate', () => openModelModal(model, 'duplicate'), rowStatus),
            ...(model.supportsThinking === false
              ? []
              : [
                  button(
                    'Effort variants',
                    () => {
                      const { body, status, close } = openModal('Create reasoning variants');
                      body.append(
                        element(
                          'p',
                          'agy-muted',
                          'Creates three copies with low, medium and high reasoning effort. The provider must support reasoning. For Google and Anthropic formats the thinking budgets are 1,024 / 4,096 / 8,192 tokens; output limits increase if needed to fit the budget. Existing models and credentials are preserved.',
                        ),
                      );
                      body.append(
                        button(
                          'Create three variants',
                          async () => {
                            requireSuccess(await ipcRenderer.invoke('storage:create-effort-variants', model.name));
                            close();
                            await modelsChanged();
                          },
                          status,
                          true,
                        ),
                      );
                    },
                    rowStatus,
                  ),
                ]),
            button('Delete', () => openDeleteModelModal(model), rowStatus),
          );
          row.append(info, actions);
          group.append(row);
        }
        content.append(group);
      }
      target.replaceChildren(content);
      restoreScroll();
    } catch (error) {
      setStatus(target, error instanceof Error ? error.message : 'Could not load custom models.', true);
    }
  }

  async function openModelModal(
    existing?: CustomModelEntry,
    mode: 'edit' | 'duplicate' | 'discover' = 'edit',
  ): Promise<void> {
    const { body, status, close } = openModal(
      mode === 'duplicate'
        ? 'Duplicate model'
        : mode === 'discover'
          ? 'Discover provider models'
          : existing
            ? 'Edit model'
            : 'Add custom model',
    );
    try {
      const presets = await storageAPI.getPresets();
      if (!body.isConnected) return;
      const providers = [...presets];
      if (existing && !providers.some((preset) => preset.id === existing.provider))
        providers.push({
          id: existing.provider,
          label: existing.provider,
          defaultUrl: existing.apiUrl,
          apiFormat: existing.apiFormat || 'openai',
          keyRequired: false,
        });
      if (!providers.length) throw new Error('Provider presets are unavailable. Close this dialog and try again.');
      const provider = selectField(
        body,
        'Provider',
        'agy-provider',
        providers.map((preset) => [preset.id, preset.label]),
        existing?.provider || providers[0].id,
      );
      const preset = () => providers.find((value) => value.id === provider.value) || providers[0];
      const apiUrl = field(body, 'API URL', 'agy-api-url', existing?.apiUrl || preset().defaultUrl, 'url');
      const workersHint = element(
        'p',
        'agy-muted',
        'Cloudflare: replace ACCOUNT_ID in the API URL with your 32-character Account ID. Use the Workers AI API token template, or keep your existing authentication headers. Model discovery verifies catalog access; generation is not tested.',
      );
      body.append(workersHint);
      function workersConnection(): boolean {
        if (provider.value === 'workers-ai') return true;
        try {
          const url = new URL(apiUrl.value);
          return url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\//.test(url.pathname);
        } catch {
          return false;
        }
      }
      const updateWorkersHint = () => {
        workersHint.hidden = !workersConnection();
      };
      apiUrl.addEventListener('input', updateWorkersHint);
      updateWorkersHint();
      const apiKey = field(
        body,
        'API key',
        'agy-api-key',
        existing?.apiKey === 'none' ? '' : existing?.apiKey || '',
        'password',
      );
      apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
      const opencodeAuth = selectField(body, 'OpenCode authentication', 'agy-opencode-auth',
        [['auth', 'API key'], ['noAuth', 'Keyless request']], existing?.apiKey && existing.apiKey !== 'none' ? 'auth' : 'noAuth');
      const opencodeHint = element('p', 'agy-muted', 'OpenCode may restrict keyless free models to its own app. If the service rejects this client, add an API key or choose another model/provider.');
      body.append(opencodeHint);
      const isOpencode = () => ['opencode', 'zen'].includes(provider.value) || (() => {
        try { const url = new URL(apiUrl.value); return url.origin === 'https://opencode.ai' && !/\/(?:zen|inference)\/go\//.test(url.pathname); } catch { return false; }
      })();
      const keylessOpencode = () => isOpencode() && opencodeAuth.value === 'noAuth';
      const updateOpencodeAuth = () => {
        opencodeAuth.closest('label')!.hidden = !isOpencode();
        opencodeHint.hidden = !isOpencode();
        apiKey.closest('label')!.hidden = provider.value === 'google-cloudcode' || keylessOpencode();
      };
      opencodeAuth.addEventListener('change', updateOpencodeAuth);
      apiUrl.addEventListener('input', updateOpencodeAuth);
      updateOpencodeAuth();
      const apiFormat = selectField(
        body,
        'API format',
        'agy-api-format',
        [
          ['openai', 'OpenAI compatible'],
          ['anthropic', 'Anthropic Messages'],
          ['google', 'Google Gemini'],
        ],
        existing?.apiFormat || preset().apiFormat,
      );
      const grid = element('div', 'agy-grid');
      const modelId = field(
        grid,
        'Provider model ID',
        'agy-model-id',
        mode === 'discover' ? '' : existing?.externalModelName || '',
      );
      const displayName = field(
        grid,
        'Display name',
        'agy-display-name',
        mode === 'duplicate'
          ? `${existing?.displayName || existing?.externalModelName || ''} copy`
          : mode === 'discover'
            ? ''
            : existing?.displayName || '',
      );
      body.append(grid);
      const name = field(
        body,
        'Configuration name (unique)',
        'agy-model-name',
        mode === 'duplicate' ? uniqueName(`${existing?.name}-copy`) : mode === 'discover' ? '' : existing?.name || '',
      );
      name.placeholder = 'Generated from provider and model ID when left blank';
      const description = field(body, 'Description', 'agy-description', String(existing?.description || ''));
      const googleConfig = element('div');
      googleConfig.id = 'agy-google-account-config';
      const googleProject = field(
        googleConfig,
        'Default Cloud Code project (optional)',
        'agy-google-project',
        String(existing?.googleProject || ''),
      );
      const initialPool = existing?.googlePool as
        | { strategy?: string; maxConcurrency?: number; cooldownMs?: number; preferredAccountId?: string; nativeFailoverEnabled?: boolean }
        | undefined;
      const poolGrid = element('div', 'agy-grid');
      const poolStrategy = selectField(
        poolGrid,
        'Account selection',
        'agy-google-pool-strategy',
        [
          ['round-robin', 'Round robin'],
          ['least-loaded', 'Least loaded'],
          ['quota', 'Remaining quota'],
          ['adaptive', 'Adaptive health and load'],
        ],
        initialPool?.strategy || 'least-loaded',
      );
      const poolConcurrency = field(
        poolGrid,
        'Maximum requests per account',
        'agy-google-pool-concurrency',
        String(initialPool?.maxConcurrency || 2),
        'number',
      );
      const poolCooldown = field(
        poolGrid,
        'Account cooldown (milliseconds)',
        'agy-google-pool-cooldown',
        String(initialPool?.cooldownMs || 60000),
        'number',
      );
      const nativeFailover = selectField(poolGrid, 'Native Google request fallback', 'agy-google-native-failover',
        [['false', 'Off'], ['true', 'Use this pool for matching native models']], String(initialPool?.nativeFailoverEnabled === true));
      googleConfig.append(poolGrid);
      googleConfig.append(element('p', 'agy-muted', 'Optional fallback uses this saved Google account pool only when a native request for the exact provider model fails. It does not change your signed-in IDE account.'));
      const readAccounts = createGoogleAccountPanel(
        googleConfig,
        Array.isArray(existing?.googleAccounts) ? (existing.googleAccounts as GoogleAccountEntry[]) : [],
        existing?.name,
      );
      const updateGoogleVisibility = () => {
        const isGoogle = provider.value === 'google-cloudcode';
        googleConfig.hidden = !isGoogle;
        updateOpencodeAuth();
        apiFormat.closest('label')!.hidden = isGoogle;
      };
      updateGoogleVisibility();
      body.append(googleConfig);
      const advanced = element('details');
      advanced.append(element('summary', '', 'Advanced settings'));
      const advancedGrid = element('div', 'agy-grid');
      const effort = selectField(
        advancedGrid,
        'Reasoning effort',
        'agy-reasoning-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => [
          value,
          value || 'Provider default',
        ]),
        String(existing?.reasoningEffort || ''),
      );
      const thinking = field(
        advancedGrid,
        'Thinking budget (tokens)',
        'agy-thinking-budget',
        existing?.thinkingBudget != null ? String(existing.thinkingBudget) : '',
        'number',
      );
      const compactionEffort = selectField(
        advancedGrid,
        'Compaction reasoning effort',
        'agy-compaction-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => [
          value,
          value || 'Use normal model settings',
        ]),
        String(existing?.compactionReasoningEffort || ''),
      );
      advancedGrid.append(
        element(
          'p',
          'agy-muted',
          'Only recognized IDE continuation summaries use this effort. Choose low for faster summaries, or none if your model supports disabling reasoning. Normal chat keeps its settings.',
        ),
      );
      const maxOutput = field(
        advancedGrid,
        'Maximum output tokens',
        'agy-max-output',
        existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '',
        'number',
      );
      const context = field(
        advancedGrid,
        'Context window (tokens)',
        'agy-context-window',
        existing?.contextWindow != null ? String(existing.contextWindow) : '',
        'number',
      );
      const compactionThreshold = field(
        advancedGrid,
        'IDE compaction threshold (%)',
        'agy-compaction-threshold',
        existing?.compactionThresholdPercent != null ? String(existing.compactionThresholdPercent) : '',
        'number',
      );
      compactionThreshold.min = '10';
      compactionThreshold.max = '90';
      compactionThreshold.placeholder = 'IDE default';
      advancedGrid.append(element('p', 'agy-muted',
        'Optional, 10–90% of the actual context window in new tokens since the previous checkpoint. Native counts may differ from provider totals. With many tools, start at 50%; higher values can trim older history before a full checkpoint. Leave blank for IDE defaults. The threshold is capped to reserve the model output limit plus 1,024 tokens. Set accurate context and output limits, then fully quit and reopen the IDE; the model cache may take an additional turn to refresh.',
      ));
      advancedGrid.append(element('p', 'agy-muted',
        'IDE 2.5.5 needs at least 50,000 input tokens after those reserves. Its native picker may show a compatibility context, for example 90,000 for a real 85,000-token model. Your saved context and provider limit remain 85,000 in that example, and the custom checkpoint policy uses that real limit.',
      ));
      const timeout = field(
        advancedGrid,
        'Request timeout (milliseconds)',
        'agy-timeout',
        existing?.timeout != null ? String(existing.timeout) : '',
        'number',
      );
      const retries = field(
        advancedGrid,
        'Maximum retries (0–5)',
        'agy-max-retries',
        existing?.maxRetries != null ? String(existing.maxRetries) : '',
        'number',
      );
      retries.max = '5';
      const vision = selectField(
        advancedGrid,
        'Image input',
        'agy-vision',
        [
          ['', 'Auto detect'],
          ['true', 'Supported'],
          ['false', 'Unsupported'],
        ],
        existing?.supportsVision == null ? '' : String(existing.supportsVision),
      );
      const rawUrl = selectField(
        advancedGrid,
        'Endpoint path',
        'agy-raw-url',
        [
          ['false', 'Normalize for provider'],
          ['true', 'Use exactly as entered'],
        ],
        String(existing?.rawUrl === true),
      );
      const tls = selectField(
        advancedGrid,
        'TLS certificates',
        'agy-tls',
        [
          ['false', 'Verify certificates'],
          ['true', 'Allow self-signed certificates'],
        ],
        String(existing?.allowUnauthorized === true),
      );
      const enabled = selectField(
        advancedGrid,
        'Model state',
        'agy-enabled',
        [
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        String(existing?.enabled !== false),
      );
      advanced.append(advancedGrid);
      const fallbacks = field(
        advanced,
        'Fallback model configuration names (comma separated)',
        'agy-fallback-models',
        Array.isArray(existing?.fallbackModels) ? existing.fallbackModels.join(', ') : '',
      );
      const headers = jsonField(advanced, 'Custom headers (JSON)', 'agy-custom-headers', existing?.customHeaders);
      const extraBody = jsonField(advanced, 'Additional request fields (JSON)', 'agy-extra-body', existing?.extraBody);
      const breaker = existing?.circuitBreaker as
        | { enabled?: boolean; failureThreshold?: number; cooldownMs?: number }
        | undefined;
      const breakerGrid = element('div', 'agy-grid');
      const breakerEnabled = selectField(
        breakerGrid,
        'Circuit breaker',
        'agy-breaker-enabled',
        [
          ['', 'Default'],
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        breaker?.enabled == null ? '' : String(breaker.enabled),
      );
      const breakerThreshold = field(
        breakerGrid,
        'Failures before cooldown',
        'agy-breaker-threshold',
        breaker?.failureThreshold != null ? String(breaker.failureThreshold) : '',
        'number',
      );
      const breakerCooldown = field(
        breakerGrid,
        'Cooldown (milliseconds)',
        'agy-breaker-cooldown',
        breaker?.cooldownMs != null ? String(breaker.cooldownMs) : '',
        'number',
      );
      advanced.append(breakerGrid);
      body.append(advanced);
      const discovery = element('div', 'agy-discovery');
      const discoveryFilter = element('div');
      discoveryFilter.hidden = true;
      const discoverySearch = field(discoveryFilter, 'Search provider models', 'agy-discovery-search', '', 'search');
      discoverySearch.placeholder = 'Filter by model name or ID';
      discoverySearch.addEventListener('input', () => showChoices());
      let choices: ModelChoice[] = [];
      const selected = new Set<string>();
      function hasWorkersAuthentication(customHeaders?: Record<string, unknown>): boolean {
        const authentication = Object.fromEntries(
          Object.entries(customHeaders || {}).map(([key, value]) => [
            key.toLowerCase(),
            typeof value === 'string' ? value.trim() : '',
          ]),
        );
        return !!(
          (apiKey.value.trim() && apiKey.value.trim() !== 'none') ||
          authentication.authorization ||
          (authentication['x-auth-key'] && authentication['x-auth-email'])
        );
      }
      function connection(): Partial<CustomModelEntry> {
        const endpoint = validUrl(apiUrl.value);
        const customHeaders = readJson(headers, 'Custom headers');
        if (workersConnection()) {
          if (
            !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(
              new URL(endpoint).pathname,
            )
          )
            throw new Error('Replace ACCOUNT_ID in the Cloudflare API URL with your 32-character Account ID.');
          if (apiFormat.value !== 'openai')
            throw new Error('Cloudflare Workers AI requires the OpenAI compatible API format.');
          if (!hasWorkersAuthentication(customHeaders))
            throw new Error('Enter a Cloudflare Workers AI API token or authentication headers.');
        }
        return {
          provider: provider.value,
          apiUrl: endpoint,
          apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
          apiFormat: apiFormat.value,
          name: existing?.name,
          allowUnauthorized: tls.value === 'true',
          externalModelName: modelId.value.trim(),
          customHeaders,
          rawUrl: rawUrl.value === 'true',
          ...(provider.value === 'google-cloudcode'
            ? {
                googleAccounts: readAccounts(),
                googleProject: googleProject.value.trim(),
                googlePool: {
                  ...initialPool,
                  preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                  strategy: poolStrategy.value,
                  nativeFailoverEnabled: nativeFailover.value === 'true',
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                },
              }
            : {}),
        };
      }
      function modelConfig(id: string, title: string, localName?: string): CustomModelEntry {
        if (!id.trim() || /\s/.test(id.trim())) throw new Error('Enter a model ID without spaces.');
        if (preset().keyRequired && !keylessOpencode() && !apiKey.value.trim() && !workersConnection())
          throw new Error('Enter an API key for this provider.');
        if (provider.value === 'google-cloudcode' && !readAccounts().some((account) => account.enabled !== false))
          throw new Error('Add and enable at least one Google account.');
        const maxRetries = readNumber(retries, 'Maximum retries');
        if (maxRetries != null && maxRetries > 5) throw new Error('Maximum retries cannot exceed 5.');
        const compactionThresholdPercent = readNumber(compactionThreshold, 'IDE compaction threshold', 10);
        if (compactionThresholdPercent != null && compactionThresholdPercent > 90)
          throw new Error('IDE compaction threshold cannot exceed 90%.');
        if (compactionThresholdPercent != null && !context.value.trim())
          throw new Error('Set the actual context window before configuring the IDE compaction threshold.');
        const customHeaders = readJson(headers, 'Custom headers');
        if (customHeaders && Object.values(customHeaders).some((value) => typeof value !== 'string'))
          throw new Error('Custom header values must be strings.');
        return {
          ...(mode === 'edit' && existing ? existing : {}),
          ...connection(),
          name: localName || name.value.trim() || uniqueName(`models/${provider.value}/${id}`),
          provider: provider.value,
          apiUrl: apiUrl.value.trim(),
          apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
          externalModelName: id.trim(),
          displayName: title || id.trim(),
          description: description.value.trim(),
          enabled: enabled.value === 'true',
          apiFormat: apiFormat.value,
          googleAccounts: provider.value === 'google-cloudcode' ? readAccounts() : undefined,
          googleProject: provider.value === 'google-cloudcode' ? googleProject.value.trim() || undefined : undefined,
          googlePool:
            provider.value === 'google-cloudcode'
              ? {
                  ...initialPool,
                  preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                  strategy: poolStrategy.value,
                  nativeFailoverEnabled: nativeFailover.value === 'true',
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                }
              : undefined,
          reasoningEffort: effort.value || undefined,
          compactionReasoningEffort: compactionEffort.value || undefined,
          compactionThresholdPercent,
          thinkingBudget: readNumber(thinking, 'Thinking budget'),
          maxOutputTokens: readNumber(maxOutput, 'Maximum output tokens', 1),
          contextWindow: readNumber(context, 'Context window', 1),
          timeout: readNumber(timeout, 'Timeout', 1),
          maxRetries,
          fallbackModels: fallbacks.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          customHeaders,
          extraBody: readJson(extraBody, 'Additional request fields'),
          supportsVision: vision.value === '' ? undefined : vision.value === 'true',
          rawUrl: rawUrl.value === 'true',
          allowUnauthorized: tls.value === 'true',
          circuitBreaker:
            breakerEnabled.value || breakerThreshold.value || breakerCooldown.value
              ? {
                  enabled: breakerEnabled.value !== 'false',
                  failureThreshold: readNumber(breakerThreshold, 'Failure threshold', 1),
                  cooldownMs: readNumber(breakerCooldown, 'Cooldown', 1),
                }
              : undefined,
          ...(existing?.name && mode === 'edit'
            ? { originalName: existing.name }
            : existing?.name
              ? { copyFrom: existing.name }
              : {}),
        };
      }
      function showChoices(): void {
        discovery.replaceChildren();
        discoveryFilter.hidden = !choices.length;
        if (!choices.length) return;
        const query = discoverySearch.value.trim().toLowerCase();
        const visible = choices.filter((model) =>
          `${model.displayName || ''} ${model.id}`.toLowerCase().includes(query),
        );
        const toolbar = element('div', 'agy-actions');
        const count = element(
          'span',
          'agy-muted',
          `${visible.length} of ${choices.length} models · ${selected.size} selected`,
        );
        toolbar.append(
          count,
          button(
            query ? 'Select filtered' : 'Select all',
            () => {
              for (const model of visible) selected.add(model.id);
              showChoices();
            },
            status,
          ),
          button(
            'Clear selection',
            () => {
              selected.clear();
              showChoices();
            },
            status,
          ),
        );
        discovery.append(toolbar);
        if (!visible.length) discovery.append(element('p', 'agy-muted', 'No provider models match this search.'));
        for (const model of visible) {
          const label = element('label', 'agy-choice');
          const checkbox = element('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selected.has(model.id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(model.id);
            else selected.delete(model.id);
            count.textContent = `${visible.length} of ${choices.length} models · ${selected.size} selected`;
          });
          label.append(
            checkbox,
            element(
              'span',
              '',
              model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id,
            ),
          );
          discovery.append(label);
        }
      }
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Test connection',
          async () => {
            setStatus(status, 'Testing…');
            const result = requireSuccess(await storageAPI.testModelConnection(connection()));
            setStatus(status, result.message || 'Connection successful.');
          },
          status,
        ),
        button(
          'Test generation (may incur charges)',
          async () => {
            setStatus(status, 'Sending a short generation test…');
            const result = requireSuccess(await storageAPI.testModelGeneration(connection()));
            setStatus(status, result.message || 'Generation succeeded.');
          },
          status,
        ),
        button(
          'Fetch provider models',
          async () => {
            setStatus(status, 'Fetching models…');
            const result = await storageAPI.discoverModels(connection());
            requireSuccess(result);
            choices = result.models || [];
            discoverySearch.value = '';
            selected.clear();
            showChoices();
            setStatus(
              status,
              choices.length
                ? 'Select models below, then choose Add selected.'
                : 'This provider returned no models. You can enter a model ID manually.',
            );
          },
          status,
        ),
        button(
          'Save model',
          async () => {
            requireSuccess(await storageAPI.saveCustomModel(modelConfig(modelId.value, displayName.value.trim())));
            await modelsChanged();
            close();
          },
          status,
          true,
        ),
      );
      body.append(actions, discoveryFilter, discovery);
      body.append(
        button(
          'Add selected',
          async () => {
            if (!selected.size) throw new Error('Select at least one model from the fetched list.');
            let saved = 0;
            for (const choice of choices.filter((model) => selected.has(model.id))) {
              const prior = modelList.find(
                (model) =>
                  model.provider === provider.value &&
                  model.apiUrl === apiUrl.value.trim() &&
                  model.externalModelName === choice.id,
              );
              const config = modelConfig(
                choice.id,
                choice.displayName || choice.id,
                prior?.name || uniqueName(`models/${provider.value}/${choice.id}`),
              );
              // Prefer explicit form overrides; otherwise retain the catalog's advertised limits/capabilities.
              for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking'] as const) {
                if (config[key] === undefined && choice[key] !== undefined) config[key] = choice[key];
              }
              if (
                typeof config.contextWindow === 'number' &&
                typeof config.maxOutputTokens === 'number' &&
                config.maxOutputTokens >= config.contextWindow &&
                !maxOutput.value.trim()
              ) {
                config.maxOutputTokens = config.contextWindow > 1 ? config.contextWindow - 1 : undefined;
              }
              delete config.originalName;
              if (prior) config.originalName = prior.name;
              else if (existing?.name) config.copyFrom = existing.name;
              requireSuccess(await storageAPI.saveCustomModel(config));
              saved++;
            }
            await modelsChanged();
            setStatus(status, `Saved ${saved} models.`);
          },
          status,
        ),
      );
      provider.addEventListener('change', () => {
        apiUrl.value = preset().defaultUrl;
        apiFormat.value = preset().apiFormat;
        apiKey.value = '';
        apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
        updateWorkersHint();
        choices = [];
        selected.clear();
        discoverySearch.value = '';
        showChoices();
        updateGoogleVisibility();
      });
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : 'Could not open model settings.', true);
    }
  }

  async function openImportExport(kind: 'import' | 'export'): Promise<void> {
    const { body, status } = openModal(kind === 'export' ? 'Export models' : 'Import models');
    body.append(
      element(
        'p',
        'agy-muted',
        kind === 'export'
          ? 'Credentials are removed from this export. Add API keys on the destination device.'
          : 'Paste a model configuration as JSON or an exported base64 string. Existing configurations are merged by name.',
      ),
    );
    const input = jsonField(body, 'Configuration', 'agy-config-json', undefined);
    input.rows = 14;
    if (kind === 'export') {
      input.readOnly = true;
      try {
        input.value = JSON.stringify(await ipcRenderer.invoke('storage:export-custom-models'), null, 2);
      } catch (error) {
        setStatus(status, String(error), true);
      }
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Select all',
          () => {
            input.focus();
            input.select();
          },
          status,
        ),
        button(
          'Copy JSON',
          async () => {
            await navigator.clipboard.writeText(input.value);
            setStatus(status, 'Configuration copied.');
          },
          status,
        ),
      );
      body.append(actions);
    } else {
      const file = field(body, 'Or choose a JSON file', 'agy-import-file', '', 'file');
      file.accept = '.json,application/json';
      file.addEventListener('change', async () => {
        try {
          const selected = file.files?.[0];
          if (!selected) return;
          if (selected.size > 2 * 1024 * 1024) throw new Error('Configuration files must be smaller than 2 MB.');
          input.value = await selected.text();
        } catch (error) {
          setStatus(status, String(error), true);
        }
      });
      body.append(
        button(
          'Import configuration',
          async () => {
            if (!input.value.trim()) throw new Error('Paste a configuration or choose a file first.');
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-custom-models', input.value.trim()));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} models. Add any missing API keys before use.`);
          },
          status,
          true,
        ),
      );
    }
  }
  async function discoverLocal(): Promise<void> {
    const { body, status } = openModal('Local model servers');
    setStatus(status, 'Checking Ollama, LM Studio and llama.cpp on this computer…');
    try {
      const result = (await ipcRenderer.invoke('storage:discover-local')) as ActionResult & {
        servers?: { provider: string; apiUrl: string; models: ModelChoice[] }[];
      };
      requireSuccess(result);
      if (!body.isConnected) return;
      setStatus(
        status,
        result.servers?.length
          ? 'Choose a server to configure its models.'
          : 'No local model servers were found. Start a server or add its URL manually.',
      );
      for (const server of result.servers || []) {
        const row = element('div', 'agy-row');
        row.append(
          element('span', '', `${server.provider} · ${server.models.length} models`),
          element('div', 'agy-muted', server.apiUrl),
          button(
            'Configure',
            () =>
              openModelModal(
                { name: '', provider: server.provider, apiUrl: server.apiUrl, apiKey: 'none', externalModelName: '' },
                'discover',
              ),
            status,
          ),
        );
        body.append(row);
      }
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function openGenerationTest(model: CustomModelEntry): void {
    const { body, status } = openModal('Test model generation');
    body.append(element('p', '', `Model: ${model.displayName || model.externalModelName || model.name}`));
    body.append(
      element(
        'p',
        'agy-muted',
        'Sends one “Reply with OK.” request with a 32-token output limit using this model’s saved settings. Your provider may charge for the request. No conversation content is sent.',
      ),
    );
    body.append(
      button(
        'Run generation test',
        async () => {
          setStatus(status, 'Sending a short generation test…');
          const result = requireSuccess(await storageAPI.testModelGeneration(model));
          setStatus(status, result.message || 'Generation succeeded.');
        },
        status,
        true,
      ),
    );
  }

  async function openDiagnostics(): Promise<void> {
    const { body, status } = openModal('Proxy diagnostics');
    body.append(
      element(
        'p',
        'agy-muted',
        'Measured requests from this proxy process only; restarting clears the history. Up to 200 completed requests are retained. Prompts, responses, URLs and credentials are not recorded. Gateway requests have separate history in its dashboard.',
      ),
    );
    const summary = element('div');
    summary.id = 'agy-diagnostics-summary';
    const search = field(body, 'Filter by model or provider', 'agy-diagnostics-search');
    const recent = element('div');
    const list = element('div');
    list.id = 'agy-diagnostics-requests';
    const output = element('textarea');
    output.id = 'agy-diagnostics-export';
    output.readOnly = true;
    output.rows = 8;
    output.hidden = true;
    output.setAttribute('aria-label', 'Exported diagnostic metadata');
    let snapshot: DiagnosticsSnapshot | undefined;
    const token = (value: unknown) => (typeof value === 'number' ? value.toLocaleString() : 'unknown');
    const render = () => {
      if (!snapshot) return;
      const s = snapshot.summary;
      summary.replaceChildren(
        element(
          'p',
          '',
          `${s.requests} completed · ${snapshot.active} active · ${s.succeeded} succeeded · ${s.failed} failed · ${s.cancelled} cancelled`,
        ),
      );
      summary.append(
        element(
          'p',
          'agy-muted',
          s.measuredRequests
            ? `Provider-reported tokens: ${token(s.measuredInputRequests ? s.inputTokens : undefined)} input · ${token(s.measuredOutputRequests ? s.outputTokens : undefined)} output · ${token(s.measuredCachedRequests ? s.cachedTokens : undefined)} cached. Usage received for ${s.measuredRequests} of ${s.requests} requests; totals exclude unknown usage.`
            : 'Token usage: unknown. No provider-reported usage received yet.',
        ),
      );
      recent.replaceChildren();
      if (snapshot.recentModels.length)
        recent.append(element('p', 'agy-muted', `Recently used: ${snapshot.recentModels.join(' · ')}`));
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const rows = snapshot.requests.filter((r) => `${r.model} ${r.provider}`.toLowerCase().includes(query));
      if (!rows.length) list.append(element('p', 'agy-muted', 'No matching requests recorded.'));
      for (const r of rows) {
        const row = element('div', 'agy-row');
        row.append(element('strong', '', `${r.model} · ${r.provider}`));
        row.append(
          element(
            'div',
            'agy-muted',
            `${new Date(r.timestamp).toLocaleTimeString()} · ${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.latencyMs} ms · ${r.kind === 'generation-test' ? 'generation test' : r.stream ? 'streaming' : 'request'}`,
          ),
        );
        row.append(
          element(
            'div',
            'agy-muted',
            `Tokens: ${token(r.inputTokens)} input · ${token(r.outputTokens)} output · ${token(r.cachedTokens)} cached`,
          ),
        );
        list.append(row);
      }
    };
    const refresh = async () => {
      snapshot = await ipcRenderer.invoke('storage:get-diagnostics');
      requireSuccess(snapshot);
      if (body.isConnected) render();
    };
    search.addEventListener('input', render);
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Refresh diagnostics', refresh, status),
      button(
        'Export diagnostics',
        () => {
          output.value = JSON.stringify(snapshot, null, 2);
          output.hidden = false;
          output.focus();
          output.select();
        },
        status,
      ),
      button(
        'Clear diagnostic history',
        async () => {
          requireSuccess(await ipcRenderer.invoke('storage:clear-diagnostics'));
          output.value = '';
          output.hidden = true;
          await refresh();
        },
        status,
      ),
    );
    body.append(summary, recent, actions, output, list);
    await refresh();
  }

  async function openGateway(): Promise<void> {
    const { body, status } = openModal('Remote gateway');
    try {
      const saved = (await ipcRenderer.invoke('storage:get-gateway')) as GatewayConfig;
      if (!body.isConnected) return;
      body.append(
        element(
          'p',
          'agy-muted',
          'Connect to your proxy gateway to import its model aliases and open its management dashboard.',
        ),
      );
      const url = field(body, 'Gateway URL', 'agy-gateway-url', saved?.url || '', 'url');
      const token = field(body, 'Gateway token', 'agy-gateway-token', saved?.token || '', 'password');
      const dashboard = field(body, 'Dashboard URL (optional)', 'agy-dashboard-url', saved?.dashboardUrl || '', 'url');
      const config = (): GatewayConfig => ({
        url: validUrl(url.value),
        token: token.value.trim(),
        dashboardUrl: dashboard.value.trim() ? validUrl(dashboard.value) : '',
      });
      const save = async () => {
        requireSuccess(await ipcRenderer.invoke('storage:save-gateway', config()));
      };
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Save connection',
          async () => {
            await save();
            setStatus(status, 'Gateway connection saved.');
          },
          status,
          true,
        ),
        button(
          'Test gateway',
          async () => {
            setStatus(status, 'Connecting…');
            const result = requireSuccess(await ipcRenderer.invoke('storage:test-gateway', config()));
            setStatus(status, result.message || 'Gateway reachable and authentication accepted.');
          },
          status,
        ),
        button(
          'Import model aliases',
          async () => {
            await save();
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-gateway-models'));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} gateway models.`);
          },
          status,
        ),
        button(
          'Open dashboard',
          async () => {
            await save();
            requireSuccess(await ipcRenderer.invoke('storage:open-gateway-dashboard'));
          },
          status,
        ),
      );
      body.append(actions);
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function findSettingsMount(): HTMLElement | null {
    // Desktop settings are a modal over /c/...; older layouts use a settings route.
    // A chat span saying "MCP" is not evidence that the settings page is open.
    const settingsRoot =
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-label*="Settings" i],[role="dialog"][aria-label*="设置"],[role="dialog"][aria-label*="偏好设置"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"]',
        ),
      ).find(isSettingsContent) ||
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
        (dialog) =>
          isSettingsContent(dialog) &&
          (dialog.classList.contains('settings-modal-container') ||
            Boolean(dialog.querySelector('nav, [role="tablist"], [data-testid*="setting"], h1, h2, h3'))),
      );
    const settingsRoute =
      /^\/settings(?:\/|$)/i.test(window.location.pathname) || /^#\/?settings(?:\/|\?|$)/i.test(window.location.hash);
    const root = settingsRoot || (settingsRoute ? document.body : null);
    if (!root) return null;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,[role="heading"],div,span'));
    const headingRegex =
      /^(?:Models\s*(?:&|and)\s*Usage|Model Settings|MCP Servers|MCP|驱动模型与用量|驱动模型|模型与用量|模型与使用情况|模型和使用情况|模型设置|模型配额|MCP\s*服务器|MCP\s*服务)$/i;
    const heading = headings.find(
      (node) =>
        (node.children.length === 0 || node.matches('h1,h2,h3,h4,[role="heading"]')) &&
        headingRegex.test(node.textContent?.trim() || '') &&
        isSettingsContent(node),
    );
    if (heading) {
      const section = heading.closest('section');
      if (section && root.contains(section)) return section;
      const panel = heading.closest('[role="tabpanel"]');
      if (panel && root.contains(panel)) return panel as HTMLElement;
      let content: HTMLElement = heading;
      while (content.parentElement && content.parentElement !== root) {
        if (content.parentElement.classList.contains('overflow-y-auto')) return content;
        content = content.parentElement;
      }
      const fallback = heading.parentElement?.parentElement || heading.parentElement;
      return fallback && root.contains(fallback) ? fallback : root;
    }
    const refresh = findRefreshButton(root);
    const legacy = refresh?.parentElement?.parentElement?.parentElement;
    if (
      legacy &&
      root.contains(legacy) &&
      isSettingsContent(legacy) &&
      /MCP|Model Context Protocol|模型上下文协议/i.test(legacy.textContent || '')
    )
      return legacy;
    return null;
  }
  function injectCustomModelsSection(): void {
    const mount = findSettingsMount();
    const existing = document.getElementById('agy-custom-models-section');
    if (existing && mount && existing.parentElement === mount) return;
    existing?.remove();
    if (!mount) return;
    installStyles();
    const section = element('section');
    section.id = 'agy-custom-models-section';
    section.setAttribute('aria-label', t('Custom Models', '自定义模型'));
    const header = element('div', 'agy-toolbar');
    const addModel = button(t('Add model', '添加模型'), () => openModelModal(), undefined, true);
    addModel.id = 'agy-add-model';
    header.append(element('h2', '', t('Custom Models', '自定义模型')), addModel);
    const actions = element('div', 'agy-actions');
    actions.append(
      button(t('Discover local', '发现本地模型'), discoverLocal),
      button(t('Import', '导入'), () => openImportExport('import')),
      button(t('Export', '导出'), () => openImportExport('export')),
      button(t('Remote gateway', '远程网关'), openGateway),
      button(t('Diagnostics', '诊断'), openDiagnostics),
      button(isChinese() ? 'English' : '中文', () => {
        try {
          localStorage.setItem('agy_custom_models_lang', isChinese() ? 'en' : 'zh');
        } catch {}
        injectCustomModelsSection();
      }),
    );
    const search = field(section, t('Search models', '搜索模型'), 'agy-model-search', searchTerm, 'search');
    search.placeholder = t('Search by name, model ID or provider', '按名称、模型 ID 或提供商搜索');
    search.addEventListener('input', () => {
      searchTerm = search.value.trim().toLowerCase();
      void renderCustomModelsList();
    });
    const content = element('div');
    content.id = 'agy-custom-models-content';
    const fleet = element('div', 'agy-fleet');
    fleet.id = 'agy-google-account-pool-section';
    fleet.setAttribute('aria-label', t('Google account fleet and quotas', 'Google 账号集群与配额'));
    fleet.hidden = true;
    const status = statusNode();
    status.id = 'agy-main-status';
    section.prepend(
      header,
      element('p', 'agy-muted', t('Provider connections, local models and remote gateways.', '提供商连接、本地模型与远程网关。')),
      actions,
    );
    section.append(status, fleet, content);
    mount.append(section);
    void renderCustomModelsList();
  }
  let pickerSearch: { menu: HTMLElement; update: () => void; cleanup: () => void } | undefined;
  function pickerVisible(menu: HTMLElement): boolean {
    if (!menu.isConnected) return false;
    for (let node: HTMLElement | null = menu; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-state') === 'closed') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function checkModelPickerSearch(): void {
    if (pickerSearch) {
      if (pickerVisible(pickerSearch.menu)) { pickerSearch.update(); return; }
      pickerSearch.cleanup();
      pickerSearch = undefined;
    }
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'));
    const menu = menus.find((candidate) => {
      if (!pickerVisible(candidate) || candidate.closest('#agy-modal-overlay, #agy-custom-models-section') ||
          candidate.parentElement?.closest('[role="menu"], [role="listbox"]') ||
          candidate.matches('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]')) return false;
      const trigger = document.getElementById(candidate.getAttribute('aria-labelledby') || '');
      if (trigger?.closest('[role="menuitem"], [role="menuitemradio"]')) return false;
      const leaves = Array.from(candidate.querySelectorAll<HTMLElement>('*')).filter((node) => !node.children.length);
      const labels = leaves.map((node) => node.textContent?.trim() || '').filter(Boolean);
      return (
        (labels.slice(0, 2).includes('Model') || labels.slice(0, 2).includes('模型') || labels.slice(0, 2).includes('驱动模型')) &&
        labels.some((label) => /^(View\s+Usage|查看用量|查看使用情况|查看配额)$/i.test(label))
      );
    });
    if (!menu) return;
    installStyles();
    const box = element('div', 'agy-model-search-box');
    const input = element('input', 'agy-model-search-input');
    input.type = 'search';
    input.placeholder = t('Search models…', '搜索模型…');
    input.setAttribute('aria-label', t('Search models', '搜索模型'));
    const empty = element('div', 'agy-model-no-results', t('No matching models', '未找到匹配的模型'));
    empty.hidden = true;
    box.append(input);
    const header = Array.from(menu.querySelectorAll<HTMLElement>('*')).find(
      (node) => !node.children.length && (node.textContent?.trim() === 'Model' || node.textContent?.trim() === '模型' || node.textContent?.trim() === '驱动模型'),
    );
    (header || menu).insertAdjacentElement(header ? 'afterend' : 'afterbegin', box);
    box.after(empty);
    const displays = new Map<HTMLElement, { value: string; priority: string }>();
    const items = () => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], button'))
      .filter((node) => !node.parentElement?.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]') &&
        !node.closest('.agy-model-search-box') && !/^(View\s+Usage|查看用量|查看使用情况|查看配额)/i.test(node.textContent?.trim() || ''));
    const restore = (node: HTMLElement) => {
      const old = displays.get(node);
      if (!old) return;
      if (old.value) node.style.setProperty('display', old.value, old.priority);
      else node.style.removeProperty('display');
      displays.delete(node);
    };
    const update = () => {
      const query = input.value.trim().toLowerCase();
      let matches = 0;
      for (const node of items()) {
        const matched = !query || (node.textContent || '').toLowerCase().includes(query);
        if (matched) { if (displays.has(node)) restore(node); if (pickerVisible(node)) matches++; }
        else if (!displays.has(node)) {
          displays.set(node, { value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') });
          node.style.setProperty('display', 'none', 'important');
        }
      }
      const hidden = !query || matches > 0;
      if (empty.hidden !== hidden) empty.hidden = hidden;
    };
    for (const event of ['pointerdown', 'mousedown', 'click']) box.addEventListener(event, (e) => e.stopPropagation());
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !input.value) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); input.value = ''; update(); }
      else if (event.key === 'Enter' || event.key === 'ArrowDown') {
        event.preventDefault();
        const first = items().find((node) => pickerVisible(node) && node.getAttribute('aria-disabled') !== 'true' && !(node as HTMLButtonElement).disabled);
        if (event.key === 'Enter') first?.click();
        else first?.focus();
      }
    });
    pickerSearch = { menu, update, cleanup: () => { for (const node of displays.keys()) restore(node); box.remove(); empty.remove(); } };
    setTimeout(() => { if (box.isConnected && pickerVisible(menu)) input.focus(); }, 0);
  }
  function setupInjectionObserver(): void {
    injectCustomModelsSection();
    if (!document.body) return;
    checkModelPickerSearch();
    fleetTimer = setInterval(() => { void refreshFleetQuotas(); }, 30_000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        injectCustomModelsSection();
        checkModelPickerSearch();
      }, 150);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-state'],
    });
    window.addEventListener(
      'pagehide',
      () => {
        observer.disconnect();
        if (pending) clearTimeout(pending);
        if (fleetTimer) clearInterval(fleetTimer);
      },
      { once: true },
    );
  }

  // --- Network Interceptor for Model Injection --------------------------

  function isSafeToIntercept(url: string): boolean {
    // Never touch the internal Connect-RPC LanguageServerService channel —
    // those responses are protocol-framed, not plain JSON, and rewriting
    // them corrupts the renderer's RPC client / store hydration.
    if (url.includes('exa.language_server_pb.')) return false;
    if (url.includes('/LanguageServerService/')) return false;
    return true;
  }

  function isJsonResponse(contentType: string | null): boolean {
    return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
  }

  const customModelsCache: { models: any[]; ts: number } = { models: [], ts: 0 };

  function injectMissingCustomModels(parsed: Record<string, unknown>, customModels: any[]): boolean {
    const key = ['models', 'availableModels', 'available_models'].find((name) => parsed[name] !== undefined) || 'models';
    const collection = parsed[key];
    // Preserve list/protocol shapes we do not own; the proxy handles array catalogs.
    if (collection !== undefined && (!collection || typeof collection !== 'object' || Array.isArray(collection))) return false;
    const modelsObj = (collection || {}) as Record<string, any>;
    const legacySlug = (model: any) => 'custom-' + String(model.externalModelName || model.name || '')
      .replace(/^models\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const usedLabels = new Set(Object.values(modelsObj).map((entry) => entry?.displayName).filter((label) => typeof label === 'string'));
    let changed = false;
    for (const model of customModels) {
      if (model.nativePickerAvailable === false) continue;
      const authoritative = typeof model.nativeCatalogId === 'string' && typeof model.nativeModelId === 'string';
      const slug = authoritative ? model.nativeCatalogId : legacySlug(model);
      // Compatibility with older IPC: never guess a shared external alias for effort variants.
      if (!authoritative && customModels.filter((other) => legacySlug(other) === slug).length !== 1) continue;
      const placeholder = authoritative ? model.nativeModelId : 'MODEL_PLACEHOLDER_M' +
        (400 + hashCodeStr(String(model.displayName || model.name || 'custom-model').toLowerCase()) % 200);
      const baseLabel = model.displayName || model.name;
      // The proxy is authoritative. Reinjection must not overwrite its capabilities or add a legacy duplicate.
      if (Object.prototype.hasOwnProperty.call(modelsObj, slug) || Object.entries(modelsObj).some(([id, entry]) =>
        id.startsWith('custom-') && entry?.model === placeholder && entry.displayName === baseLabel,
      )) continue;
      let displayName = baseLabel;
      if (usedLabels.has(displayName) || customModels.filter((entry) => (entry.displayName || entry.name) === baseLabel).length > 1)
        displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')})`;
      let suffix = 2;
      while (usedLabels.has(displayName)) displayName = `${baseLabel} (${String(model.name).replace(/^models\//, '')} #${suffix++})`;
      usedLabels.add(displayName);
      modelsObj[slug] = {
        displayName, recommended: true,
        maxTokens: model.nativeContextWindow || model.contextWindow || 1048576,
        maxOutputTokens: model.nativeMaxOutputTokens || model.maxOutputTokens || 4096,
        tokenizerType: 'LLAMA_WITH_SPECIAL', model: placeholder,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE',
        ...(authoritative && model.nativeModelExperiments ? { modelExperiments: model.nativeModelExperiments } : {}),
      };
      changed = true;
    }
    if (changed) parsed[key] = modelsObj;
    return changed;
  }

  async function getCustomModelsForInjection(): Promise<any[]> {
    if (Date.now() - customModelsCache.ts < 30000) return customModelsCache.models;
    try {
      customModelsCache.models = (await storageAPI.getCustomModels()).filter((model) => model.enabled !== false);
      customModelsCache.ts = Date.now();
    } catch {
      /* ignore */
    }
    return customModelsCache.models;
  }

  // Intercept XHR to inject custom models into GetAvailableModels responses
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    (this as any)._agy_url = typeof url === 'string' ? url : url.toString();
    (this as any)._agy_method = method;
    (this as any)._agy_async = async !== false;
    return origXHROpen.call(this, method, url, async !== false, username, password);
  };

  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const url: string = (this as any)._agy_url || '';

    if ((url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) && isSafeToIntercept(url)) {
      // Warm the cache without delaying native XHR events. If it is not ready by
      // DONE, leave the response alone; load/readystatechange ordering must survive.
      if ((this as any)._agy_async) void getCustomModelsForInjection();
      const origOnReady = this.onreadystatechange;
      this.onreadystatechange = (ev: Event) => {
        if (
          this.readyState === 4 &&
          this.status === 200 &&
          (this.responseType === '' || this.responseType === 'text') &&
          isJsonResponse(this.getResponseHeader('content-type'))
        ) {
          const customModels = customModelsCache.models;
          if (customModels && customModels.length > 0) {
            try {
              const responseText = this.responseText;
              if (responseText && responseText.length > 10) {
                const parsed = JSON.parse(responseText) as Record<string, unknown>;
                if (injectMissingCustomModels(parsed, customModels)) {
                  // Override only a changed response; keep native event ordering intact.
                  Object.defineProperty(this, 'responseText', { value: JSON.stringify(parsed), writable: true });
                  Object.defineProperty(this, 'response', { value: JSON.stringify(parsed), writable: true });
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
        if (origOnReady) origOnReady.call(this, ev);
      };
    }
    return origXHRSend.call(this, body);
  };

  // Intercept fetch responses for model endpoints
  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await origFetch.call(window, input, init);

    if (
      (url.includes('GetAvailableModels') || url.includes('fetchAvailableModels')) &&
      isSafeToIntercept(url) &&
      response.ok
    ) {
      if (!isJsonResponse(response.headers.get('content-type'))) {
        return response;
      }
      const customModels = await getCustomModelsForInjection();
      if (customModels && customModels.length > 0) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text && text.length > 10) {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (!injectMissingCustomModels(parsed, customModels)) return response;
            return new Response(JSON.stringify(parsed), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }
    return response;
  };

  function hashCodeStr(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i);
      h = h & h;
    }
    return Math.abs(h);
  }

  // Start the observer
  setupInjectionObserver();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initCustomPreload);
  } else {
    initCustomPreload();
  }
}
