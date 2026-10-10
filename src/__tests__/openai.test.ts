/**
 * Unit tests for OpenAI translator (openai.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from '../proxy/translators/openai';

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

// ─── mapGeminiToOpenAI ─────────────────────────────────────────────────────

describe('mapGeminiToOpenAI', () => {
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
    const result = mapGeminiToOpenAI(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parametersJsonSchema }] }],
      },
      'external-model',
    );
    expect(result.tools![0].function.parameters).toEqual(original);
    expect(result.tools![0].function.parameters).not.toBe(parametersJsonSchema);
    expect(parametersJsonSchema).toEqual(original);
  });

  it('normalizes string-encoded JSON Schema integer bounds recursively without changing source', () => {
    const parametersJsonSchema = {
      type: 'object',
      properties: {
        page: { type: 'array', minItems: '1', maxItems: '10', items: { type: 'string', minLength: '2' } },
        choice: {
          oneOf: [{ type: 'string', maxLength: '20', default: '1', enum: ['1', '2'] }],
        },
        untouched: { type: 'string', pattern: '^1
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('should convert user messages correctly', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi there!' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Hi there!', reasoning_content: '' });
  });

  it('should handle functionCall parts as tool_calls', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'search', args: { query: 'test' }, id: 'call_123' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('search');
  });

  it('preserves assistant text alongside tool calls without exposing thought parts', () => {
    const result = mapGeminiToOpenAI(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'The previous write failed. ' },
              { text: 'Internal reasoning', thought: true },
              { functionCall: { name: 'write_to_file', id: 'retry-write', args: { TargetFile: '/tmp/retry.txt' } } },
              { text: 'Retrying with the corrected path.' },
            ],
          },
        ],
      },
      'external-model',
    );
    expect(result.messages[0].content).toBe('The previous write failed. Retrying with the corrected path.');
    expect(result.messages[0].tool_calls).toEqual([
      {
        id: 'retry-write',
        type: 'function',
        function: { name: 'write_to_file', arguments: '{"TargetFile":"/tmp/retry.txt"}' },
      },
    ]);
  });

  it.each([false, true])('keeps tool failure text after all matching tool results (split items: %s)', (splitItems) => {
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
    const result = mapGeminiToOpenAI(body, 'external-model');
    expect(result.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'write-2', content: '{}' },
      { role: 'tool', tool_call_id: 'write-1', content: '{"error":"Permission denied"}' },
      { role: 'user', content: `${failure}\nCorrect the arguments before retrying.` },
    ]);
    expect(result.messages[0].tool_calls!.map((call) => call.id)).toEqual(['write-1', 'write-2']);
    expect(body).toEqual(original);
  });

  it('should handle functionResponse parts as tool messages', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'result data' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('result data');
  });

  it('should include temperature and max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.5, maxOutputTokens: 2000 },
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.5);
    expect(result.max_tokens).toBe(2000);
  });

  it('should use defaults when generationConfig is missing', () => {
    const body = { contents: [] };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(4000);
  });

  it('should convert Gemini tools to OpenAI format', () => {
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
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect((result.tools![0].function.parameters as Record<string, string>).type).toBe('object');
  });

  it('should include reasoning_content on assistant messages', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer', thought: false },
            { text: 'thinking...', thought: true },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'deepseek-model');
    const assistant = result.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning_content).toBe('thinking...');
  });

  it('should handle multiple contents', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Q1' }] },
        { role: 'model', parts: [{ text: 'A1' }] },
        { role: 'user', parts: [{ text: 'Q2' }] },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user');
  });
});

// ─── mapOpenAIToGemini ─────────────────────────────────────────────────────

describe('mapOpenAIToGemini', () => {
  it('preserves a failure explanation beside a retry tool call in a JSON response', () => {
    const explanation = 'The write failed because the tool rejected AbsolutePath. I will retry with TargetFile.';
    const args = { TargetFile: '/tmp/retry.txt', CodeContent: 'hello', Overwrite: false };
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              content: explanation,
              tool_calls: [
                {
                  id: 'retry-write',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'external-model',
    );
    expect(result.candidates[0].content.parts).toEqual([
      { text: explanation },
      { functionCall: { name: 'write_to_file', args, id: 'retry-write' } },
    ]);
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
  });

  it('keeps valid write_to_file arguments within the schema sent to the provider', () => {
    const args = { TargetFile: '/workspace/example.txt', CodeContent: 'Hello.', Overwrite: false };
    const parameters = {
      type: 'OBJECT',
      properties: { TargetFile: { type: 'STRING' }, CodeContent: { type: 'STRING' }, Overwrite: { type: 'BOOLEAN' } },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const request = mapGeminiToOpenAI(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters }] }],
      },
      'qwen-test',
    );
    const sentSchema = request.tools![0].function.parameters;
    expect(sentSchema).toMatchObject({
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' }, Overwrite: { type: 'boolean' } },
      required: parameters.required,
      additionalProperties: false,
    });
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'write-call',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'qwen-test',
    );
    const call = result.candidates[0].content.parts[0].functionCall!;
    expect(call).toEqual({ name: 'write_to_file', args, id: 'write-call' });
    expect(Object.keys(call.args).sort()).toEqual(Object.keys(sentSchema.properties!).sort());
  });

  it.each(toolArgumentCases)(
    'preserves valid $name arguments without guessing path fields',
    ({ name, args, schemas }) => {
      const result = mapOpenAIToGemini(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'preserved-call',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'external-model',
        schemas,
      );
      expect(result.candidates[0].content.parts[0].functionCall).toEqual({ name, args, id: 'preserved-call' });
    },
  );

  it('should convert simple text response', () => {
    const res = {
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert tool_calls to functionCall parts', () => {
    const res = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    expect(result.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(result.candidates[0].content.parts[0].functionCall!.name).toBe('search');
  });

  it('should parse DSML tool calls from text content', () => {
    const res = {
      choices: [
        {
          message: {
            content:
              'Here is result\n<DSML|invoke name="search_web">\n<DSML|parameter name="query" string="true">news</DSML|parameter>\n</DSML|invoke>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });

  it('should include reasoning_content as thought part', () => {
    const res = {
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'thinking...' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'thinking...')).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should handle empty choices gracefully', () => {
    const res = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    expect(() => mapOpenAIToGemini(res, 'gpt-4o')).not.toThrow();
  });

  it('should handle missing usage', () => {
    const res = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata!.totalTokenCount).toBe(0);
  });

  it('should handle finish_reason other than stop', () => {
    const res = {
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('OTHER');
  });
});

// ─── mapOpenAIChunkToGemini (Streaming) ────────────────────────────────────

describe('mapOpenAIChunkToGemini', () => {
  describe.each(['tool_calls', 'stop'])('when finishing with %s', (finishReason) => {
    it.each(toolArgumentCases)('preserves fragmented $name arguments', ({ name, args, schemas }) => {
      const streamKey = `preserve-${finishReason}-${name}`;
      const serialized = JSON.stringify(args);
      const fragments = [serialized.slice(0, 9), serialized.slice(9, 31), serialized.slice(31)];
      for (const [index, fragment] of fragments.entries()) {
        const result = mapOpenAIChunkToGemini(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      ...(index === 0 ? { id: 'fragmented-call' } : {}),
                      function: { ...(index === 0 ? { name } : {}), arguments: fragment },
                    },
                  ],
                },
              },
            ],
          },
          'external-model',
          streamKey,
          schemas,
        );
        expect(result).toBeNull();
      }
      const result = mapOpenAIChunkToGemini(
        { choices: [{ delta: {}, finish_reason: finishReason }] },
        'external-model',
        streamKey,
        schemas,
      );
      expect(result?.finishReason).toBe('TOOL_CALL');
      expect(result?.content.parts).toEqual([{ functionCall: { name, args, id: 'fragmented-call' } }]);
      expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
    });
  });

  it('should return text delta chunk', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { content: 'Hello' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should return reasoning delta as thought part', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'thinking...', thought: true });
  });

  it('should accumulate and emit tool calls on finish_reason tool_calls', () => {
    // Accumulate tool call fragments
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"test"}' } }] }, index: 0 }],
      },
      'gpt-4o',
    );

    // Final chunk with tool_calls finish
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('TOOL_CALL');
  });

  it('should handle stop finish with pending tool calls', () => {
    mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"/f"}' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );

    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    // If tool calls were pending, they should be emitted
  });

  it('should handle stop finish with no pending state', () => {
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_clean',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for empty choice', () => {
    const chunk = { id: 'empty', choices: [] };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('should detect DSML tool calls in accumulated streaming text', () => {
    const dsmlText =
      'Result:\n<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>';
    const chunk = {
      id: 'stream_dsml',
      choices: [{ delta: { content: dsmlText }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    const fcParts = result!.content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });
});
, default: '1' },
      },
      $defs: { config: { type: 'object', minProperties: '1', maxProperties: '3' } },
      allOf: [{ type: 'object', properties: { label: { type: 'string', minLength: '0' } } }],
    };
    const original = structuredClone(parametersJsonSchema);
    const result = mapGeminiToOpenAI(
      { contents: [], tools: [{ functionDeclarations: [{ name: 'list_resources', parametersJsonSchema }] }] },
      'deepseek-flash',
    );
    const schema = result.tools![0].function.parameters;
    expect(schema).toMatchObject({
      properties: {
        page: { minItems: 1, maxItems: 10, items: { minLength: 2 } },
        choice: { oneOf: [{ maxLength: 20, default: '1', enum: ['1', '2'] }] },
        untouched: { pattern: '^1
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('should convert user messages correctly', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi there!' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Hi there!', reasoning_content: '' });
  });

  it('should handle functionCall parts as tool_calls', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'search', args: { query: 'test' }, id: 'call_123' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('search');
  });

  it('preserves assistant text alongside tool calls without exposing thought parts', () => {
    const result = mapGeminiToOpenAI(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'The previous write failed. ' },
              { text: 'Internal reasoning', thought: true },
              { functionCall: { name: 'write_to_file', id: 'retry-write', args: { TargetFile: '/tmp/retry.txt' } } },
              { text: 'Retrying with the corrected path.' },
            ],
          },
        ],
      },
      'external-model',
    );
    expect(result.messages[0].content).toBe('The previous write failed. Retrying with the corrected path.');
    expect(result.messages[0].tool_calls).toEqual([
      {
        id: 'retry-write',
        type: 'function',
        function: { name: 'write_to_file', arguments: '{"TargetFile":"/tmp/retry.txt"}' },
      },
    ]);
  });

  it.each([false, true])('keeps tool failure text after all matching tool results (split items: %s)', (splitItems) => {
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
    const result = mapGeminiToOpenAI(body, 'external-model');
    expect(result.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'write-2', content: '{}' },
      { role: 'tool', tool_call_id: 'write-1', content: '{"error":"Permission denied"}' },
      { role: 'user', content: `${failure}\nCorrect the arguments before retrying.` },
    ]);
    expect(result.messages[0].tool_calls!.map((call) => call.id)).toEqual(['write-1', 'write-2']);
    expect(body).toEqual(original);
  });

  it('should handle functionResponse parts as tool messages', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'result data' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('result data');
  });

  it('should include temperature and max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.5, maxOutputTokens: 2000 },
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.5);
    expect(result.max_tokens).toBe(2000);
  });

  it('should use defaults when generationConfig is missing', () => {
    const body = { contents: [] };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(4000);
  });

  it('should convert Gemini tools to OpenAI format', () => {
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
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect((result.tools![0].function.parameters as Record<string, string>).type).toBe('object');
  });

  it('should include reasoning_content on assistant messages', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer', thought: false },
            { text: 'thinking...', thought: true },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'deepseek-model');
    const assistant = result.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning_content).toBe('thinking...');
  });

  it('should handle multiple contents', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Q1' }] },
        { role: 'model', parts: [{ text: 'A1' }] },
        { role: 'user', parts: [{ text: 'Q2' }] },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user');
  });
});

// ─── mapOpenAIToGemini ─────────────────────────────────────────────────────

describe('mapOpenAIToGemini', () => {
  it('preserves a failure explanation beside a retry tool call in a JSON response', () => {
    const explanation = 'The write failed because the tool rejected AbsolutePath. I will retry with TargetFile.';
    const args = { TargetFile: '/tmp/retry.txt', CodeContent: 'hello', Overwrite: false };
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              content: explanation,
              tool_calls: [
                {
                  id: 'retry-write',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'external-model',
    );
    expect(result.candidates[0].content.parts).toEqual([
      { text: explanation },
      { functionCall: { name: 'write_to_file', args, id: 'retry-write' } },
    ]);
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
  });

  it('keeps valid write_to_file arguments within the schema sent to the provider', () => {
    const args = { TargetFile: '/workspace/example.txt', CodeContent: 'Hello.', Overwrite: false };
    const parameters = {
      type: 'OBJECT',
      properties: { TargetFile: { type: 'STRING' }, CodeContent: { type: 'STRING' }, Overwrite: { type: 'BOOLEAN' } },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const request = mapGeminiToOpenAI(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters }] }],
      },
      'qwen-test',
    );
    const sentSchema = request.tools![0].function.parameters;
    expect(sentSchema).toMatchObject({
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' }, Overwrite: { type: 'boolean' } },
      required: parameters.required,
      additionalProperties: false,
    });
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'write-call',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'qwen-test',
    );
    const call = result.candidates[0].content.parts[0].functionCall!;
    expect(call).toEqual({ name: 'write_to_file', args, id: 'write-call' });
    expect(Object.keys(call.args).sort()).toEqual(Object.keys(sentSchema.properties!).sort());
  });

  it.each(toolArgumentCases)(
    'preserves valid $name arguments without guessing path fields',
    ({ name, args, schemas }) => {
      const result = mapOpenAIToGemini(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'preserved-call',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'external-model',
        schemas,
      );
      expect(result.candidates[0].content.parts[0].functionCall).toEqual({ name, args, id: 'preserved-call' });
    },
  );

  it('should convert simple text response', () => {
    const res = {
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert tool_calls to functionCall parts', () => {
    const res = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    expect(result.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(result.candidates[0].content.parts[0].functionCall!.name).toBe('search');
  });

  it('should parse DSML tool calls from text content', () => {
    const res = {
      choices: [
        {
          message: {
            content:
              'Here is result\n<DSML|invoke name="search_web">\n<DSML|parameter name="query" string="true">news</DSML|parameter>\n</DSML|invoke>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });

  it('should include reasoning_content as thought part', () => {
    const res = {
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'thinking...' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'thinking...')).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should handle empty choices gracefully', () => {
    const res = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    expect(() => mapOpenAIToGemini(res, 'gpt-4o')).not.toThrow();
  });

  it('should handle missing usage', () => {
    const res = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata!.totalTokenCount).toBe(0);
  });

  it('should handle finish_reason other than stop', () => {
    const res = {
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('OTHER');
  });
});

// ─── mapOpenAIChunkToGemini (Streaming) ────────────────────────────────────

describe('mapOpenAIChunkToGemini', () => {
  describe.each(['tool_calls', 'stop'])('when finishing with %s', (finishReason) => {
    it.each(toolArgumentCases)('preserves fragmented $name arguments', ({ name, args, schemas }) => {
      const streamKey = `preserve-${finishReason}-${name}`;
      const serialized = JSON.stringify(args);
      const fragments = [serialized.slice(0, 9), serialized.slice(9, 31), serialized.slice(31)];
      for (const [index, fragment] of fragments.entries()) {
        const result = mapOpenAIChunkToGemini(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      ...(index === 0 ? { id: 'fragmented-call' } : {}),
                      function: { ...(index === 0 ? { name } : {}), arguments: fragment },
                    },
                  ],
                },
              },
            ],
          },
          'external-model',
          streamKey,
          schemas,
        );
        expect(result).toBeNull();
      }
      const result = mapOpenAIChunkToGemini(
        { choices: [{ delta: {}, finish_reason: finishReason }] },
        'external-model',
        streamKey,
        schemas,
      );
      expect(result?.finishReason).toBe('TOOL_CALL');
      expect(result?.content.parts).toEqual([{ functionCall: { name, args, id: 'fragmented-call' } }]);
      expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
    });
  });

  it('should return text delta chunk', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { content: 'Hello' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should return reasoning delta as thought part', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'thinking...', thought: true });
  });

  it('should accumulate and emit tool calls on finish_reason tool_calls', () => {
    // Accumulate tool call fragments
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"test"}' } }] }, index: 0 }],
      },
      'gpt-4o',
    );

    // Final chunk with tool_calls finish
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('TOOL_CALL');
  });

  it('should handle stop finish with pending tool calls', () => {
    mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"/f"}' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );

    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    // If tool calls were pending, they should be emitted
  });

  it('should handle stop finish with no pending state', () => {
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_clean',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for empty choice', () => {
    const chunk = { id: 'empty', choices: [] };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('should detect DSML tool calls in accumulated streaming text', () => {
    const dsmlText =
      'Result:\n<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>';
    const chunk = {
      id: 'stream_dsml',
      choices: [{ delta: { content: dsmlText }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    const fcParts = result!.content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });
});
, default: '1' },
      },
      $defs: { config: { minProperties: 1, maxProperties: 3 } },
      allOf: [{ properties: { label: { minLength: 0 } } }],
    });
    expect(parametersJsonSchema).toEqual(original);
  });

  it('leaves invalid, negative, fractional and unsafe integer constraints unchanged', () => {
    const schema = {
      type: 'object',
      minProperties: 'NaN',
      maxProperties: '9007199254740992',
      properties: { list: { type: 'array', minItems: '-1', maxItems: '1.5' } },
    };
    const result = mapGeminiToOpenAI(
      { contents: [], tools: [{ functionDeclarations: [{ name: 'list_resources', parametersJsonSchema: schema }] }] },
      'deepseek-flash',
    );
    expect(result.tools![0].function.parameters).toEqual(schema);
  });

  it('should convert systemInstruction to system message', () => {
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('should convert user messages correctly', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi there!' }] }],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Hi there!', reasoning_content: '' });
  });

  it('should handle functionCall parts as tool_calls', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'search', args: { query: 'test' }, id: 'call_123' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('search');
  });

  it('preserves assistant text alongside tool calls without exposing thought parts', () => {
    const result = mapGeminiToOpenAI(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'The previous write failed. ' },
              { text: 'Internal reasoning', thought: true },
              { functionCall: { name: 'write_to_file', id: 'retry-write', args: { TargetFile: '/tmp/retry.txt' } } },
              { text: 'Retrying with the corrected path.' },
            ],
          },
        ],
      },
      'external-model',
    );
    expect(result.messages[0].content).toBe('The previous write failed. Retrying with the corrected path.');
    expect(result.messages[0].tool_calls).toEqual([
      {
        id: 'retry-write',
        type: 'function',
        function: { name: 'write_to_file', arguments: '{"TargetFile":"/tmp/retry.txt"}' },
      },
    ]);
  });

  it.each([false, true])('keeps tool failure text after all matching tool results (split items: %s)', (splitItems) => {
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
    const result = mapGeminiToOpenAI(body, 'external-model');
    expect(result.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'write-2', content: '{}' },
      { role: 'tool', tool_call_id: 'write-1', content: '{"error":"Permission denied"}' },
      { role: 'user', content: `${failure}\nCorrect the arguments before retrying.` },
    ]);
    expect(result.messages[0].tool_calls!.map((call) => call.id)).toEqual(['write-1', 'write-2']);
    expect(body).toEqual(original);
  });

  it('should handle functionResponse parts as tool messages', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'result data' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('result data');
  });

  it('should include temperature and max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.5, maxOutputTokens: 2000 },
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.5);
    expect(result.max_tokens).toBe(2000);
  });

  it('should use defaults when generationConfig is missing', () => {
    const body = { contents: [] };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(4000);
  });

  it('should convert Gemini tools to OpenAI format', () => {
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
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect((result.tools![0].function.parameters as Record<string, string>).type).toBe('object');
  });

  it('should include reasoning_content on assistant messages', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer', thought: false },
            { text: 'thinking...', thought: true },
          ],
        },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'deepseek-model');
    const assistant = result.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning_content).toBe('thinking...');
  });

  it('should handle multiple contents', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Q1' }] },
        { role: 'model', parts: [{ text: 'A1' }] },
        { role: 'user', parts: [{ text: 'Q2' }] },
      ],
    };
    const result = mapGeminiToOpenAI(body, 'gpt-4o');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user');
  });
});

// ─── mapOpenAIToGemini ─────────────────────────────────────────────────────

describe('mapOpenAIToGemini', () => {
  it('preserves a failure explanation beside a retry tool call in a JSON response', () => {
    const explanation = 'The write failed because the tool rejected AbsolutePath. I will retry with TargetFile.';
    const args = { TargetFile: '/tmp/retry.txt', CodeContent: 'hello', Overwrite: false };
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              content: explanation,
              tool_calls: [
                {
                  id: 'retry-write',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'external-model',
    );
    expect(result.candidates[0].content.parts).toEqual([
      { text: explanation },
      { functionCall: { name: 'write_to_file', args, id: 'retry-write' } },
    ]);
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
  });

  it('keeps valid write_to_file arguments within the schema sent to the provider', () => {
    const args = { TargetFile: '/workspace/example.txt', CodeContent: 'Hello.', Overwrite: false };
    const parameters = {
      type: 'OBJECT',
      properties: { TargetFile: { type: 'STRING' }, CodeContent: { type: 'STRING' }, Overwrite: { type: 'BOOLEAN' } },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const request = mapGeminiToOpenAI(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters }] }],
      },
      'qwen-test',
    );
    const sentSchema = request.tools![0].function.parameters;
    expect(sentSchema).toMatchObject({
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' }, Overwrite: { type: 'boolean' } },
      required: parameters.required,
      additionalProperties: false,
    });
    const result = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'write-call',
                  type: 'function',
                  function: { name: 'write_to_file', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'qwen-test',
    );
    const call = result.candidates[0].content.parts[0].functionCall!;
    expect(call).toEqual({ name: 'write_to_file', args, id: 'write-call' });
    expect(Object.keys(call.args).sort()).toEqual(Object.keys(sentSchema.properties!).sort());
  });

  it.each(toolArgumentCases)(
    'preserves valid $name arguments without guessing path fields',
    ({ name, args, schemas }) => {
      const result = mapOpenAIToGemini(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'preserved-call',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'external-model',
        schemas,
      );
      expect(result.candidates[0].content.parts[0].functionCall).toEqual({ name, args, id: 'preserved-call' });
    },
  );

  it('should convert simple text response', () => {
    const res = {
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert tool_calls to functionCall parts', () => {
    const res = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    expect(result.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(result.candidates[0].content.parts[0].functionCall!.name).toBe('search');
  });

  it('should parse DSML tool calls from text content', () => {
    const res = {
      choices: [
        {
          message: {
            content:
              'Here is result\n<DSML|invoke name="search_web">\n<DSML|parameter name="query" string="true">news</DSML|parameter>\n</DSML|invoke>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });

  it('should include reasoning_content as thought part', () => {
    const res = {
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'thinking...' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'deepseek-v4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'thinking...')).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should handle empty choices gracefully', () => {
    const res = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    expect(() => mapOpenAIToGemini(res, 'gpt-4o')).not.toThrow();
  });

  it('should handle missing usage', () => {
    const res = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata!.totalTokenCount).toBe(0);
  });

  it('should handle finish_reason other than stop', () => {
    const res = {
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = mapOpenAIToGemini(res, 'gpt-4o');
    expect(result.candidates[0].finishReason).toBe('OTHER');
  });
});

// ─── mapOpenAIChunkToGemini (Streaming) ────────────────────────────────────

describe('mapOpenAIChunkToGemini', () => {
  describe.each(['tool_calls', 'stop'])('when finishing with %s', (finishReason) => {
    it.each(toolArgumentCases)('preserves fragmented $name arguments', ({ name, args, schemas }) => {
      const streamKey = `preserve-${finishReason}-${name}`;
      const serialized = JSON.stringify(args);
      const fragments = [serialized.slice(0, 9), serialized.slice(9, 31), serialized.slice(31)];
      for (const [index, fragment] of fragments.entries()) {
        const result = mapOpenAIChunkToGemini(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      ...(index === 0 ? { id: 'fragmented-call' } : {}),
                      function: { ...(index === 0 ? { name } : {}), arguments: fragment },
                    },
                  ],
                },
              },
            ],
          },
          'external-model',
          streamKey,
          schemas,
        );
        expect(result).toBeNull();
      }
      const result = mapOpenAIChunkToGemini(
        { choices: [{ delta: {}, finish_reason: finishReason }] },
        'external-model',
        streamKey,
        schemas,
      );
      expect(result?.finishReason).toBe('TOOL_CALL');
      expect(result?.content.parts).toEqual([{ functionCall: { name, args, id: 'fragmented-call' } }]);
      expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
    });
  });

  it('should return text delta chunk', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { content: 'Hello' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should return reasoning delta as thought part', () => {
    const chunk = {
      id: 'stream_1',
      choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'thinking...', thought: true });
  });

  it('should accumulate and emit tool calls on finish_reason tool_calls', () => {
    // Accumulate tool call fragments
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );
    mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"test"}' } }] }, index: 0 }],
      },
      'gpt-4o',
    );

    // Final chunk with tool_calls finish
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_tc',
        choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('TOOL_CALL');
  });

  it('should handle stop finish with pending tool calls', () => {
    mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"/f"}' } }] },
            index: 0,
          },
        ],
      },
      'gpt-4o',
    );

    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_stop_tc',
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    // If tool calls were pending, they should be emitted
  });

  it('should handle stop finish with no pending state', () => {
    const result = mapOpenAIChunkToGemini(
      {
        id: 'stream_clean',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop', index: 0 }],
      },
      'gpt-4o',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for empty choice', () => {
    const chunk = { id: 'empty', choices: [] };
    const result = mapOpenAIChunkToGemini(chunk, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('should detect DSML tool calls in accumulated streaming text', () => {
    const dsmlText =
      'Result:\n<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>';
    const chunk = {
      id: 'stream_dsml',
      choices: [{ delta: { content: dsmlText }, index: 0 }],
    };
    const result = mapOpenAIChunkToGemini(chunk, 'deepseek-v4');
    expect(result).not.toBeNull();
    const fcParts = result!.content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });
});
