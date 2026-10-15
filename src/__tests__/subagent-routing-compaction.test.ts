import { describe, expect, it } from 'vitest';
import { SubagentRoutingBridge } from '../proxy/subagentRouting';
import type { GeminiBody } from '../proxy/requestOptions';

const resolve = (name: string) => (['custom-a', 'custom-b', 'custom-c'].includes(name) ? name : undefined);
const request = (text: string, conversationId = 'parent'): GeminiBody => ({
  conversationId,
  contents: [{ role: 'user', parts: [{ text }] }],
});

function spawn(bridge: SubagentRoutingBridge, models: string[], conversationId = 'parent') {
  const context = bridge.prepareRequest(request('Delegate the task.', conversationId), resolve).context;
  return bridge
    .rewriteCandidate(
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'invoke_subagent',
                args: { Subagents: models.map((Model, index) => ({ Model, Prompt: `Task ${index}` })) },
              },
            },
          ],
        },
      },
      context,
      resolve,
    )
    .content.parts[0].functionCall.args.Subagents.map((entry) => entry.Prompt);
}

function checkpoint(prompts: string[]) {
  return [
    '# Resuming from a compaction',
    '',
    'You are continuing work on the task described above, but you have lost access to the full conversation history.',
    '',
    '<summary>Continue the audit. No final report has been written.</summary>',
    '',
    '# Subagents',
    'The following subagents were spawned during this conversation (up to 20).',
    ...prompts.map((initialPrompt) => JSON.stringify({ spec: { initialPrompt } }, null, 2)),
    '',
    '# Conversation Logs',
    'Read the saved transcript if additional context is required.',
  ].join('\n');
}

describe('subagent route markers quoted in compaction snapshots', () => {
  it('continues a parent with three quoted child routes without selecting a child model', () => {
    const bridge = new SubagentRoutingBridge();
    const prompts = spawn(bridge, ['custom-a', 'custom-b', 'custom-c']);
    const body = request(checkpoint(prompts));
    const original = structuredClone(body);
    const prepared = bridge.prepareRequest(body, resolve);
    expect(prepared.modelName).toBeUndefined();
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route:');
    expect(prepared.body.contents[0].parts[0].text).toContain('Continue the audit.');
    expect(body).toEqual(original);
  });

  it('continues a parent from a saved snapshot after the route cache was cleared', () => {
    const bridge = new SubagentRoutingBridge();
    const text = checkpoint(spawn(bridge, ['custom-a', 'custom-b']));
    bridge.clear();
    const prepared = bridge.prepareRequest(request(text), resolve);
    expect(prepared.modelName).toBeUndefined();
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route:');
  });

  it('does not route an unrelated conversation using a single quoted historical prompt', () => {
    const bridge = new SubagentRoutingBridge();
    const [prompt] = spawn(bridge, ['custom-b']);
    const prepared = bridge.prepareRequest(request(checkpoint([prompt]), 'unrelated'), resolve);
    expect(prepared.modelName).toBeUndefined();
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route:');
  });

  it('preserves a bound child model while removing other child snapshots from its compacted context', () => {
    const bridge = new SubagentRoutingBridge();
    const prompts = spawn(bridge, ['custom-a', 'custom-b', 'custom-c']);
    bridge.prepareRequest(request(prompts[0], 'child-a'), resolve);
    const prepared = bridge.prepareRequest(request(checkpoint(prompts), 'child-a'), resolve);
    expect(prepared.modelName).toBe('custom-a');
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route:');
  });

  it('routes a real wrapped child prompt even when its task quotes a checkpoint', () => {
    const bridge = new SubagentRoutingBridge();
    const oldPrompts = spawn(bridge, ['custom-a', 'custom-b']);
    const context = bridge.prepareRequest(request('Delegate a recovery task.'), resolve).context;
    const candidate = bridge.rewriteCandidate(
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'invoke_subagent',
                args: {
                  Subagents: [{ Model: 'custom-c', Prompt: `Review this checkpoint:\n${checkpoint(oldPrompts)}` }],
                },
              },
            },
          ],
        },
      },
      context,
      resolve,
    );
    const prompt = candidate.content.parts[0].functionCall.args.Subagents[0].Prompt;
    const prepared = bridge.prepareRequest(
      request(`<SYSTEM_MESSAGE>\n${prompt}\n</SYSTEM_MESSAGE>`, 'recovery-child'),
      resolve,
    );
    expect(prepared.modelName).toBe('custom-c');
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route:');
  });

  it('still rejects two active standalone markers in one child prompt', () => {
    const bridge = new SubagentRoutingBridge();
    const prompts = spawn(bridge, ['custom-a', 'custom-b']);
    expect(() => bridge.prepareRequest(request(prompts.join('\n'), 'child'), resolve)).toThrow(/Multiple/);
  });

  it('still rejects an unknown standalone marker instead of falling back silently', () => {
    const bridge = new SubagentRoutingBridge();
    expect(() =>
      bridge.prepareRequest(
        request('Task\n\n[antigravity-subagent-route:11111111-1111-4111-8111-111111111111]', 'child'),
        resolve,
      ),
    ).toThrow(/expired or is unknown/);
  });

  it.each([
    ['trailing space', (text: string) => text + ' '],
    ['indentation', (text: string) => text.replace('[antigravity-subagent-route:', '  [antigravity-subagent-route:')],
    ['inline marker', (text: string) => text.replace('\n\n', ' ')],
  ])('preserves the selected model with %s around an active marker', (_label, format) => {
    const bridge = new SubagentRoutingBridge();
    const [prompt] = spawn(bridge, ['custom-b']);
    const prepared = bridge.prepareRequest(request(format(prompt), 'child'), resolve);
    expect(prepared.modelName).toBe('custom-b');
  });

  it('leaves unrelated JSON values and ordinary user text unchanged', () => {
    const bridge = new SubagentRoutingBridge();
    const text = 'Keep this exact text. {"initialPrompt":"A normal task","other":"value"}';
    expect(bridge.prepareRequest(request(text), resolve).body.contents[0].parts[0].text).toBe(text);
  });

  it('still rejects active markers quoted in an unrelated JSON property', () => {
    const bridge = new SubagentRoutingBridge();
    const [prompt] = spawn(bridge, ['custom-b']);
    expect(() => bridge.prepareRequest(request(JSON.stringify({ note: prompt })), resolve)).toThrow(
      /parent conversation/,
    );
  });
});
