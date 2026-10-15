import { describe, it, expect } from 'vitest';
import {
  isOpencodeFreeModel,
  isOpencodeProvider,
  canonicalSessionID,
  clientProjectID,
  buildOpencodeHeaders,
  normalizeOpencodeEndpoint,
  prepareOpencodeFreeBody,
  parseSSEToOpenAIResponse,
  OPENCODE_CORE_TOOL_NAMES,
  OPENCODE_CORE_TOOLS,
} from '../proxy/opencodeFingerprint';
import { getProviderHeaders } from '../proxy/registry';
import { modelListUrl } from '../modelManagement';

describe('OpenCode Free Tier & Keyless (noAuth) Support', () => {
  describe('Model and Provider Classification', () => {
    it('identifies known OpenCode free models and models ending with -free', () => {
      expect(isOpencodeFreeModel('cat-jam-free')).toBe(true);
      expect(isOpencodeFreeModel('big-pickle')).toBe(true);
      expect(isOpencodeFreeModel('mimo-v2.6-flash-free')).toBe(true);
      expect(isOpencodeFreeModel('step-5-preview-free')).toBe(true);
      expect(isOpencodeFreeModel('custom-model-free')).toBe(true);
      expect(isOpencodeFreeModel('gpt-4o')).toBe(false);
      expect(isOpencodeFreeModel('claude-3-7-sonnet')).toBe(false);
      expect(isOpencodeFreeModel('')).toBe(false);
      expect(isOpencodeFreeModel(undefined)).toBe(false);
    });

    it('identifies OpenCode provider variants', () => {
      expect(isOpencodeProvider('opencode')).toBe(true);
      expect(isOpencodeProvider('zen')).toBe(true);
      expect(isOpencodeProvider('opencode-go')).toBe(true);
      expect(isOpencodeProvider('openai')).toBe(false);
      expect(isOpencodeProvider('anthropic')).toBe(false);
    });
  });

  describe('Session ID & Fingerprint Header Generation', () => {
    it('generates canonical descending session IDs in ses_ + 12 hex + 14 Base62 layout', () => {
      const sessionId = canonicalSessionID();
      expect(sessionId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(sessionId.length).toBe(30);
    });

    it('generates 40-character hex project IDs', () => {
      const projectId = clientProjectID();
      expect(projectId).toMatch(/^[0-9a-f]{40}$/);
    });

    it('builds official CLI headers for keyless (noAuth) access', () => {
      const headers = buildOpencodeHeaders();
      expect(headers['Authorization']).toBe('Bearer public');
      expect(headers['User-Agent']).toBe('opencode/latest/2.0.29/cli');
      expect(headers['x-opencode-client']).toBe('cli');
      expect(headers['x-opencode-session']).toMatch(/^ses_/);
      expect(headers['x-opencode-session-id']).toBe(headers['x-opencode-session']);
      expect(headers['x-opencode-project']).toMatch(/^[0-9a-f]{40}$/);
      expect(headers).not.toHaveProperty('x-opencode-request');
    });

    it('builds headers with provided API key when authenticated', () => {
      const headers = buildOpencodeHeaders('sk-opencode-test-key');
      expect(headers['Authorization']).toBe('Bearer sk-opencode-test-key');
    });

    it('treats apiKey="none" as public keyless access', () => {
      const headers = buildOpencodeHeaders('none');
      expect(headers['Authorization']).toBe('Bearer public');
    });
  });

  describe('Endpoint Normalization', () => {
    it('normalizes free model endpoints to https://opencode.ai/inference/v1/chat/completions', () => {
      const chatUrl = normalizeOpencodeEndpoint('https://opencode.ai/zen/v1/chat/completions', 'cat-jam-free');
      expect(chatUrl).toBe('https://opencode.ai/inference/v1/chat/completions');

      const legacyUrl = normalizeOpencodeEndpoint('https://opencode.ai/v1/chat/completions', 'big-pickle');
      expect(legacyUrl).toBe('https://opencode.ai/inference/v1/chat/completions');
    });

    it('normalizes responses format for free models', () => {
      const responsesUrl = normalizeOpencodeEndpoint('https://opencode.ai/zen/v1/chat/completions', 'cat-jam-free', true);
      expect(responsesUrl).toBe('https://opencode.ai/inference/v1/responses');
    });

    it('leaves non-opencode endpoints untouched', () => {
      const url = 'https://api.openai.com/v1/chat/completions';
      expect(normalizeOpencodeEndpoint(url, 'cat-jam-free')).toBe(url);
    });
  });

  describe('Payload Normalization (Tool Injection & Forced Streaming)', () => {
    it('forces stream: true and injects all 5 core tools for free models', () => {
      const raw = {
        model: 'cat-jam-free',
        messages: [{ role: 'user', content: 'hello' }],
      };
      const prepared = prepareOpencodeFreeBody(raw);
      expect(prepared.stream).toBe(true);
      expect(prepared.stream_options).toEqual({ include_usage: true });
      expect(prepared.tool_choice).toBe('none');

      const toolNames = prepared.tools.map((t: any) => t.function?.name || t.name);
      for (const expected of OPENCODE_CORE_TOOL_NAMES) {
        expect(toolNames).toContain(expected);
        expect(OPENCODE_CORE_TOOLS[expected]).toBeDefined();
      }
    });

    it('preserves existing tools when injecting missing core tools', () => {
      const raw = {
        model: 'big-pickle',
        messages: [{ role: 'user', content: 'test' }],
        tools: [
          {
            type: 'function',
            function: { name: 'my_custom_tool', description: 'desc', parameters: { type: 'object' } },
          },
        ],
      };
      const prepared = prepareOpencodeFreeBody(raw);
      const toolNames = prepared.tools.map((t: any) => t.function?.name);
      expect(toolNames).toContain('my_custom_tool');
      for (const expected of OPENCODE_CORE_TOOL_NAMES) {
        expect(toolNames).toContain(expected);
      }
    });
  });

  describe('SSE Stream to JSON Chat Completion Collapsing', () => {
    it('collapses forced SSE stream events into a full chat completion response', () => {
      const rawSSE = [
        'data: {"id":"chatcmpl-test1","model":"cat-jam-free","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
        'data: {"id":"chatcmpl-test1","model":"cat-jam-free","choices":[{"index":0,"delta":{"content":"Hello"}}]}',
        'data: {"id":"chatcmpl-test1","model":"cat-jam-free","choices":[{"index":0,"delta":{"content":" world!"}}]}',
        'data: {"id":"chatcmpl-test1","model":"cat-jam-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"id":"chatcmpl-test1","model":"cat-jam-free","usage":{"prompt_tokens":10,"completion_tokens":2}}',
        'data: [DONE]',
      ].join('\n');

      const result = parseSSEToOpenAIResponse(rawSSE, 'cat-jam-free');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('chatcmpl-test1');
      expect(result!.model).toBe('cat-jam-free');
      expect(result!.choices[0].message.role).toBe('assistant');
      expect(result!.choices[0].message.content).toBe('Hello world!');
      expect(result!.choices[0].finish_reason).toBe('stop');
      expect(result!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2 });
    });

    it('handles reasoning and tool call deltas in forced SSE stream', () => {
      const rawSSE = [
        'data: {"id":"chatcmpl-test2","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Thinking deeply..."}}]}',
        'data: {"id":"chatcmpl-test2","model":"big-pickle","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"read","arguments":"{\\"path\\": "}}]}}]}',
        'data: {"id":"chatcmpl-test2","model":"big-pickle","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]}}]}',
        'data: {"id":"chatcmpl-test2","model":"big-pickle","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ].join('\n');

      const result = parseSSEToOpenAIResponse(rawSSE, 'big-pickle');
      expect(result).not.toBeNull();
      expect(result!.choices[0].message.reasoning_content).toBe('Thinking deeply...');
      expect(result!.choices[0].message.tool_calls).toHaveLength(1);
      expect(result!.choices[0].message.tool_calls[0].function.name).toBe('read');
      expect(result!.choices[0].message.tool_calls[0].function.arguments).toBe('{"path": "test.txt"}');
      expect(result!.choices[0].finish_reason).toBe('tool_calls');
    });
  });

  describe('Registry and Model Discovery Integration', () => {
    it('sets Bearer public for OpenCode providers in registry when key is absent', () => {
      const headers = getProviderHeaders('opencode');
      expect(headers['Authorization']).toBe('Bearer public');
      expect(headers['User-Agent']).toBe('opencode/latest/2.0.29/cli');

      const zenHeaders = getProviderHeaders('zen', 'none');
      expect(zenHeaders['Authorization']).toBe('Bearer public');
    });

    it('resolves correct model listing URL for OpenCode endpoints', () => {
      const inferenceListUrl = modelListUrl('https://opencode.ai/inference/v1/chat/completions', 'openai', 'opencode');
      expect(inferenceListUrl).toBe('https://opencode.ai/inference/v1/models');

      const zenListUrl = modelListUrl('https://opencode.ai/zen/v1/chat/completions', 'openai', 'zen');
      expect(zenListUrl).toBe('https://opencode.ai/zen/v1/models');
    });
  });
});
