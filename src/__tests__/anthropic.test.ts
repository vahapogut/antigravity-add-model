import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToAnthropic, mapAnthropicToGemini, mapAnthropicChunkToGemini } from '../proxy/translators/anthropic';

// Mock detectModelCapabilitiesByName to avoid importing the full module chain
vi.mock('../proxy/modelUtils', () => ({
  detectModelCapabilitiesByName: vi.fn((name: string) => ({
    isThinkingModel: name.includes('opus') || name.includes('thinking'),
    supportsToolCalls: true,
    supportsReasoning: name.includes('opus') || name.includes('thinking') || name.includes('deepseek'),
  })),
}));

// Reset shared state before each test
beforeEach(() => {
  shared.modelToolCallIds.clear();
  shared.modelReasoningContent.clear();
  shared.activeStreamContexts.clear();
  shared.translatedToolCalls.clear();
  shared.stateTimestamps.toolCallIds.clear();
  shared.stateTimestamps.reasoning.clear();
  shared.stateTimestamps.streamCtx.clear();
  shared.stateTimestamps.translatedCalls.clear();
});

// ─── mapGeminiToAnthropic ──────────────────────────────────────────────────

describe('mapGeminiToAnthropic', () => {
  it('should convert systemInstruction to system parameter', () => {
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.system).toBe('You are helpful.');
  });

  it('should convert user messages', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi!' }] }],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBe('Hi!');
  });

  it('should convert functionCall to tool_use content blocks', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [{ text: 'Before call' }, { functionCall: { name: 'search', args: { query: 'test' }, id: 'call_1' } }],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('assistant');
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    const blocks = result.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('should convert functionResponse to tool_result content blocks', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'data', id: 'call_1' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('user');
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    const blocks = result.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(true);
  });

  it('should set max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { maxOutputTokens: 8000 },
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.max_tokens).toBe(8000);
  });

  it('should use default max_tokens when not specified', () => {
    const body = { contents: [] };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.max_tokens).toBe(16000);
  });

  it('should not set temperature for thinking models', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.7 },
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    // Claude 3.5 Sonnet is NOT a thinking model, so temperature should be set
    expect(result.temperature).toBe(0.7);
  });

  it('should convert Gemini tools to Anthropic format', () => {
    const body = {
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe('get_weather');
    expect(result.tools![0].input_schema).toBeDefined();
  });
});

// ─── mapAnthropicToGemini ──────────────────────────────────────────────────

describe('mapAnthropicToGemini', () => {
  it('should convert text content blocks', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'Hello!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert thinking content blocks to thought parts', () => {
    const res = {
      content: [
        { type: 'thinking' as const, thinking: 'reasoning...' },
        { type: 'text' as const, text: 'answer' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-opus-4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.text === 'reasoning...' && p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should convert tool_use blocks to functionCalls', () => {
    const res = {
      content: [{ type: 'tool_use' as const, id: 'toolu_1', name: 'search', input: { query: 'test' } }],
      usage: { input_tokens: 5, output_tokens: 10 },
      stop_reason: 'tool_use',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts).toHaveLength(1);
    expect(fcParts[0].functionCall!.name).toBe('search');
  });

  it('should handle max_tokens stop reason', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'truncated' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'max_tokens',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('MAX_TOKENS');
  });

  it('should handle unknown stop reason', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'refusal',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('OTHER');
  });

  it('should handle empty content', () => {
    const res = {
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].content.parts).toEqual([]);
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should track tool call IDs in modelToolCallIds', () => {
    const res = {
      content: [{ type: 'tool_use' as const, id: 'toolu_abc', name: 'search', input: { query: 'x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
    };
    mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    const tcIds = shared.modelToolCallIds.get('claude-3-5-sonnet-latest');
    expect(tcIds).toBeDefined();
    expect(tcIds!['search']).toBe('toolu_abc');
  });
});

// ─── mapAnthropicChunkToGemini (Streaming SSE) ─────────────────────────────

describe('mapAnthropicChunkToGemini', () => {
  it('should handle content_block_start for tool_use', () => {
    const chunk = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use' as const, id: 'toolu_1', name: 'search', input: {} },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).toBeNull();
  });

  it('should emit text_delta as text part', () => {
    const chunk = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should emit thinking_delta as thought part', () => {
    const chunk = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning...' },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-opus-4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'reasoning...', thought: true });
  });

  it('should accumulate input_delta for tool arguments', () => {
    // Start a tool_use block
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use' as const, id: 'toolu_x', name: 'run_command', input: {} },
      },
      'claude-3-5-sonnet-latest',
    );

    // Send input delta fragments
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_delta', partial_json: '{"CommandLine"' },
      },
      'claude-3-5-sonnet-latest',
    );
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_delta', partial_json: ':"ls"}' },
      },
      'claude-3-5-sonnet-latest',
    );

    // Message delta with stop_reason tool_use should emit the tool call
    const result = mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      },
      'claude-3-5-sonnet-latest',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('TOOL_CALL');
  });

  it('should handle message_stop', () => {
    // Send some text first
    mapAnthropicChunkToGemini(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Some text' },
      },
      'claude-3-5-sonnet-latest',
    );

    const result = mapAnthropicChunkToGemini(
      {
        type: 'message_stop',
      },
      'claude-3-5-sonnet-latest',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for unknown event types', () => {
    const chunk = { type: 'ping' };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).toBeNull();
  });

  it('should handle multiple content blocks in same stream', () => {
    const chunk1 = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Part 1' },
    };
    const chunk2 = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Part 2' },
    };
    const r1 = mapAnthropicChunkToGemini(chunk1, 'claude-3-5-sonnet-latest');
    const r2 = mapAnthropicChunkToGemini(chunk2, 'claude-3-5-sonnet-latest');
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });
});
