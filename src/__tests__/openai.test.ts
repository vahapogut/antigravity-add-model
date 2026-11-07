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
  it.each(['parameters', 'parametersJsonSchema'] as const)(
    'converts serialized minLength in %s before sending an agent tool to the provider',
    (schemaField) => {
      const schema = {
        type: 'OBJECT',
        properties: { command: { type: 'STRING', minLength: '1' } },
        required: ['command'],
        additionalProperties: false,
      };
      const original = structuredClone(schema);
      const result = mapGeminiToOpenAI(
        { contents: [], tools: [{ functionDeclarations: [{ name: 'run_command', [schemaField]: schema }] }] },
        'cloudflare-agent-model',
      );
      expect(result.tools![0].function.parameters).toEqual({
        ...schema,
        type: 'object',
        properties: { command: { type: 'string', minLength: 1 } },
      });
      expect(schema).toEqual(original);
    },
  );

  it.each(['parameters', 'parametersJsonSchema'] as const)(
    'sends an empty properties object for a zero-argument tool declared in %s (issue #35)',
    (schemaField) => {
      const schema = { type: 'object' };
      const result = mapGeminiToOpenAI(
        {
          contents: [],
          tools: [{ functionDeclarations: [{ name: 'list_plugin_accounts', [schemaField]: schema }] }],
        },
        'lm-studio-model',
      );
      expect(result.tools![0].function.parameters).toEqual({ type: 'object', properties: {} });
      expect(schema).toEqual({ type: 'object' });
    },
  );

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
    expect(result.messages[0].reasoning_content).toBe('Internal reasoning');
    expect(result.messages[0].tool_calls).toEqual([
      {
        id: 'retry-write',
        type: 'function',
        function: { name: 'write_to_file', arguments: '{"TargetFile":"/tmp/retry.txt"}' },
      },
    ]);
  });

  it.each([false, true])('replays each tool turn\'s own reasoning after results (parallel: %s)', (parallel) => {
    const firstCalls = [
      { functionCall: { name: 'inspect_file', id: 'inspect-a', args: { path: 'a.txt' } } },
      ...(parallel ? [{ functionCall: { name: 'inspect_file', id: 'inspect-b', args: { path: 'b.txt' } } }] : []),
    ];
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Compare the files, then verify the result.' }] },
        {
          role: 'model',
          parts: [{ text: 'Inspect first. ', thought: true }, ...firstCalls, { text: 'Then compare.', thought: true }],
        },
        {
          role: 'user',
          parts: firstCalls.map(({ functionCall }) => ({
            functionResponse: { name: functionCall.name, id: functionCall.id, response: { exists: true } },
          })),
        },
        {
          role: 'model',
          parts: [
            { text: 'The files match. ', thought: true },
            { text: 'Verifying the comparison.' },
            { functionCall: { name: 'verify_result', id: 'verify-1', args: { expected: 'match' } } },
            { text: 'Confirm before finishing.', thought: true },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'verify_result', id: 'verify-1', response: { verified: true } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'inspect_file' }, { name: 'verify_result' }] }],
    };
    const original = structuredClone(body);
    shared.modelReasoningContent.set('other-conversation', 'Unrelated reasoning must not be replayed.');
    const result = mapGeminiToOpenAI(body, 'reasoning-provider', 'this-conversation');
    const assistants = result.messages.filter((message) => message.role === 'assistant');
    expect(assistants.map((message) => message.reasoning_content)).toEqual([
      'Inspect first. Then compare.',
      'The files match. Confirm before finishing.',
    ]);
    expect(assistants.map((message) => message.content)).toEqual([null, 'Verifying the comparison.']);
    expect(assistants.flatMap((message) => message.tool_calls!.map((call) => call.id))).toEqual([
      ...firstCalls.map(({ functionCall }) => functionCall.id), 'verify-1',
    ]);
    expect(result.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
      .toEqual([...firstCalls.map(({ functionCall }) => functionCall.id), 'verify-1']);
    expect(result.messages).toHaveLength(parallel ? 6 : 5);
    expect(result.tools!.map((tool) => tool.function.name)).toEqual(['inspect_file', 'verify_result']);
    expect(body).toEqual(original);
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
    expect(result.candidates[0].finishReason).toBe('STOP');
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
    expect(result.candidates[0].finishReason).toBe('STOP');
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
    expect(result.candidates[0].finishReason).toBe('STOP');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts.length).toBeGreaterThan(0);
  });

  it.each([
    ['reasoning_content', false],
    ['reasoning', false],
    ['reasoning_content', true],
    ['reasoning', true],
  ] as const)('round-trips %s through a nonstream tool response (DSML: %s)', (field, dsml) => {
    const message = {
      [field]: 'After inspecting the file, verify its checksum.',
      content: dsml
        ? 'Inspecting.\n<DSML|invoke name="inspect_file"><DSML|parameter name="path" string="true">a.txt</DSML|parameter></DSML|invoke>'
        : 'Inspecting.',
      ...(!dsml ? { tool_calls: [{
        id: 'inspect-response', type: 'function' as const,
        function: { name: 'inspect_file', arguments: '{"path":"a.txt"}' },
      }] } : {}),
    };
    const response = { choices: [{ message, finish_reason: dsml ? 'stop' : 'tool_calls' }] };
    const original = structuredClone(response);
    const native = mapOpenAIToGemini(response, 'reasoning-provider').candidates[0];
    expect(native.content.parts.filter((part) => part.thought)).toEqual([
      { text: 'After inspecting the file, verify its checksum.', thought: true },
    ]);
    const toolPart = native.content.parts.find((part) => part.functionCall)!;
    expect(toolPart.functionCall).toMatchObject({ name: 'inspect_file', args: { path: 'a.txt' } });
    if (!dsml) expect(toolPart.functionCall!.id).toBe('inspect-response');
    expect(native.finishReason).toBe('STOP');
    const replay = mapGeminiToOpenAI({ contents: [native.content] }, 'reasoning-provider').messages[0];
    expect(replay.reasoning_content).toBe(message[field]);
    expect(replay.content).toBe('Inspecting.');
    expect(replay.tool_calls![0].function).toEqual({ name: 'inspect_file', arguments: '{"path":"a.txt"}' });
    expect(response).toEqual(original);
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
      expect(result?.finishReason).toBe('STOP');
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
    expect(result!.finishReason).toBe('STOP');
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

  it('emits DSML calls only after the upstream finishes', () => {
    const dsmlText =
      'Result:\n<DSML|invoke name="run_command">\n<DSML|parameter name="CommandLine" string="true">ls</DSML|parameter>\n</DSML|invoke>';
    const chunk = {
      id: 'stream_dsml',
      choices: [{ delta: { content: dsmlText }, index: 0 }],
    };
    expect(mapOpenAIChunkToGemini(chunk, 'deepseek-v4', 'stream_dsml', new Map())?.content.parts).toEqual([
      { text: 'Result:\n' },
    ]);
    const result = mapOpenAIChunkToGemini(
      { id: 'stream_dsml', choices: [{ delta: {}, finish_reason: 'stop' }] },
      'deepseek-v4',
      'stream_dsml',
      new Map(),
    );
    expect(result?.finishReason).toBe('STOP');
    expect(result?.content.parts).toEqual([{ functionCall: { name: 'run_command', args: { CommandLine: 'ls' } } }]);
    expect(shared.activeStreamContexts.has('stream_dsml')).toBe(false);
  });

  it.each(['stop', 'tool_calls'])('retains split parallel DSML calls until terminal %s', (finishReason) => {
    const streamKey = `parallel-dsml-${finishReason}`;
    const first =
      '<DSML|tool_calls><DSML|invoke name="first"><DSML|parameter name="x" string="true">1</DSML|parameter></DSML|invoke><DSML|invoke name="second"><DSML|parameter name="y" string="true">';
    const second = '2</DSML|parameter></DSML|invoke></DSML|tool_calls>';
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: first } }] }, 'test', streamKey, new Map()),
    ).toBeNull();
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: second } }] }, 'test', streamKey, new Map()),
    ).toBeNull();
    const result = mapOpenAIChunkToGemini(
      { choices: [{ delta: {}, finish_reason: finishReason }] },
      'test',
      streamKey,
      new Map(),
    );
    expect(result?.finishReason).toBe('STOP');
    expect(result?.content.parts).toEqual([
      { functionCall: { name: 'first', args: { x: '1' } } },
      { functionCall: { name: 'second', args: { y: '2' } } },
    ]);
    expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
  });

  it('buffers a split DSML marker without duplicating earlier text', () => {
    const key = 'partial-marker';
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: 'Checking now. ' } }] }, 'test', key)?.content.parts,
    ).toEqual([{ text: 'Checking now. ' }]);
    expect(mapOpenAIChunkToGemini({ choices: [{ delta: { content: '<DS' } }] }, 'test', key)).toBeNull();
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: 'ML|invoke name="lookup">' } }] }, 'test', key),
    ).toBeNull();
    const result = mapOpenAIChunkToGemini(
      { choices: [{ delta: { content: '</DSML|invoke>' }, finish_reason: 'stop' }] },
      'test',
      key,
      new Map(),
    );
    expect(result?.content.parts).toEqual([{ functionCall: { name: 'lookup', args: {} } }]);
    expect(result?.finishReason).toBe('STOP');
  });

  it.each(['reasoning_content', 'reasoning'])(
    'preserves terminal %s and completed tool arguments in one candidate',
    (field) => {
      const key = `terminal-${field}`;
      mapOpenAIChunkToGemini(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'terminal-reasoning-call', function: { name: 'lookup', arguments: '{"x":' } },
                ],
              },
            },
          ],
        },
        'test',
        key,
        new Map(),
      );
      const result = mapOpenAIChunkToGemini(
        {
          choices: [
            {
              delta: { [field]: 'The tool is ready.', tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'test',
        key,
        new Map(),
      );
      expect(result?.finishReason).toBe('STOP');
      expect(result?.content.parts).toEqual([
        { text: 'The tool is ready.', thought: true },
        { functionCall: { name: 'lookup', args: { x: 1 }, id: 'terminal-reasoning-call' } },
      ]);
      expect(shared.activeStreamContexts.has(key)).toBe(false);
    },
  );

  it('flushes a possible DSML marker that turns out to be ordinary text', () => {
    const key = 'ordinary-marker-prefix';
    expect(mapOpenAIChunkToGemini({ choices: [{ delta: { content: 'Use <' } }] }, 'test', key)?.content.parts).toEqual([
      { text: 'Use ' },
    ]);
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: 'div> elements' } }] }, 'test', key)?.content.parts,
    ).toEqual([{ text: '<div> elements' }]);
    expect(
      mapOpenAIChunkToGemini({ choices: [{ delta: { content: ' <DS' }, finish_reason: 'stop' }] }, 'test', key)?.content
        .parts,
    ).toEqual([{ text: ' <DS' }]);
  });
});
