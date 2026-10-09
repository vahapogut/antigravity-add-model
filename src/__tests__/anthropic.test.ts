import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToAnthropic, mapAnthropicToGemini, mapAnthropicChunkToGemini } from '../proxy/translators/anthropic';

const toolArgumentCases: Array<{
  name: string;
  args: Record<string, unknown>;
  schemas?: ReadonlyMap<string, unknown>;
}> = [
  {
    name: 'write_to_file',
    args: {
      TargetFile: '/workspace/example.txt',
      CodeContent: 'Hello.\nKeep /literal/path unchanged.',
      Overwrite: false,
    },
  },
  {
    name: 'mcp__files__write',
    args: { path: '/workspace/example.txt', content: 'Hello.', metadata: { file: 'notes.md' } },
  },
  { name: 'send_note', args: { message: 'This is a sentence.', priority: 'normal' } },
  {
    name: 'write_file',
    args: { path: '/workspace/example.txt', content: 'A declared lowercase path must stay lowercase.' },
    schemas: new Map([
      [
        'write_file',
        {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      ],
    ]),
  },
];

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
  it('preserves parametersJsonSchema properties, references, and additional-property constraints', () => {
    const parametersJsonSchema = {
      type: 'object',
      $defs: { filePath: { type: 'string', minLength: 1 } },
      properties: {
        TargetFile: { $ref: '#/$defs/filePath' },
        CodeContent: { type: 'string' },
        Overwrite: { type: 'boolean' },
      },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const original = structuredClone(parametersJsonSchema);
    const result = mapGeminiToAnthropic(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parametersJsonSchema }] }],
      },
      'external-model',
    );
    expect(result.tools![0].input_schema).toEqual(original);
    expect(result.tools![0].input_schema).not.toBe(parametersJsonSchema);
    expect(parametersJsonSchema).toEqual(original);
  });

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

  it.each([false, true])('keeps tool failure text after matching tool results (split items: %s)', (splitItems) => {
    const failure = 'WRITE_ERROR: invalid tool call: additional properties AbsolutePath not allowed';
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'write_to_file', id: 'write-1', args: { TargetFile: '/tmp/first.txt' } } },
            { functionCall: { name: 'write_to_file', id: 'write-2', args: { TargetFile: '/tmp/second.txt' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: failure },
            { functionResponse: { name: 'write_to_file', id: 'write-2', response: {} } },
            { text: 'Internal note', thought: true },
            { text: 'Correct the arguments before retrying.' },
            { functionResponse: { name: 'write_to_file', id: 'write-1', response: { error: 'Permission denied' } } },
          ],
        },
      ],
    };
    if (splitItems) {
      const results = body.contents.pop()!;
      body.contents.push(
        { ...results, parts: results.parts.slice(0, 2) },
        { ...results, parts: results.parts.slice(2) },
      );
    }
    const original = structuredClone(body);
    const result = mapGeminiToAnthropic(body, 'external-model');
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'write-2', content: '{}' },
        { type: 'tool_result', tool_use_id: 'write-1', content: '{"error":"Permission denied"}' },
        { type: 'text', text: failure },
        { type: 'text', text: 'Correct the arguments before retrying.' },
      ],
    });
    expect(result.messages[0].content).toMatchObject([{ id: 'write-1' }, { id: 'write-2' }]);
    expect(body).toEqual(original);
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
  it('keeps valid write_to_file arguments within the schema sent to the provider', () => {
    const args = { TargetFile: '/workspace/example.txt', CodeContent: 'Hello.', Overwrite: false };
    const parameters = {
      type: 'OBJECT',
      properties: { TargetFile: { type: 'STRING' }, CodeContent: { type: 'STRING' }, Overwrite: { type: 'BOOLEAN' } },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const request = mapGeminiToAnthropic(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters }] }],
      },
      'claude-test',
    );
    const sentSchema = request.tools![0].input_schema;
    expect(sentSchema).toMatchObject({
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' }, Overwrite: { type: 'boolean' } },
      required: parameters.required,
      additionalProperties: false,
    });
    const result = mapAnthropicToGemini(
      {
        content: [{ type: 'tool_use', id: 'write-call', name: 'write_to_file', input: args }],
        stop_reason: 'tool_use',
      },
      'claude-test',
    );
    const call = result.candidates[0].content.parts[0].functionCall!;
    expect(call).toEqual({ name: 'write_to_file', args, id: 'write-call' });
    expect(Object.keys(call.args).sort()).toEqual(Object.keys(sentSchema.properties!).sort());
  });

  it.each(toolArgumentCases)(
    'preserves valid $name arguments without guessing path fields',
    ({ name, args, schemas }) => {
      const result = mapAnthropicToGemini(
        {
          content: [{ type: 'tool_use', id: 'preserved-call', name, input: args }],
          stop_reason: 'tool_use',
        },
        'external-model',
        schemas,
      );
      expect(result.candidates[0].content.parts[0].functionCall).toEqual({ name, args, id: 'preserved-call' });
    },
  );

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
    expect(result.candidates[0].finishReason).toBe('STOP');
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
  it.each(toolArgumentCases)('preserves fragmented $name input_json_delta arguments', ({ name, args, schemas }) => {
    const streamKey = `preserve-${name}`;
    expect(
      mapAnthropicChunkToGemini(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'fragmented-call', name, input: {} },
        },
        'external-model',
        streamKey,
        schemas,
      ),
    ).toBeNull();
    const serialized = JSON.stringify(args);
    for (const fragment of [serialized.slice(0, 9), serialized.slice(9, 31), serialized.slice(31)]) {
      expect(
        mapAnthropicChunkToGemini(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: fragment },
          },
          'external-model',
          streamKey,
          schemas,
        ),
      ).toBeNull();
    }
    const result = mapAnthropicChunkToGemini(
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      },
      'external-model',
      streamKey,
      schemas,
    );
    expect(result?.finishReason).toBe('STOP');
    expect(result?.content.parts).toEqual([{ functionCall: { name, args, id: 'fragmented-call' } }]);
    expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
  });

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
    expect(result!.finishReason).toBe('STOP');
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
