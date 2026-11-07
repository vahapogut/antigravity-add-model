import { describe, expect, it, vi } from 'vitest';
import { SubagentRoutingBridge, SubagentRoutingError } from '../proxy/subagentRouting';
import type { GeminiBody } from '../proxy/requestOptions';
import { translateRequest } from '../proxy/registry';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const resolve = (name: string) => (['custom-a', 'custom-b', 'custom-c'].includes(name) ? name : undefined);
const parent = (conversationId = 'parent'): GeminiBody => ({
  conversationId,
  contents: [{ role: 'user', parts: [{ text: 'Delegate the task.' }] }],
});
const candidate = (models: (string | undefined)[], id?: string) => ({
  content: {
    role: 'model',
    parts: [
      {
        functionCall: {
          ...(id ? { id } : {}),
          name: 'invoke_subagent',
          args: { Subagents: models.map((Model, index) => ({ ...(Model ? { Model } : {}), Prompt: `Task ${index}` })) },
        },
      },
    ],
  },
});
type Candidate = ReturnType<typeof candidate>;
const call = (value: Candidate) => value.content.parts[0].functionCall;
const prompt = (value: Candidate, index = 0) => call(value).args.Subagents[index].Prompt;
const child = (text: string, conversationId = 'child'): GeminiBody => ({
  conversationId,
  contents: [{ role: 'user', parts: [{ text }] }],
});
function spawn(bridge: SubagentRoutingBridge, models = ['custom-a'], scope = 'parent', id?: string) {
  const context = bridge.prepareRequest(parent(scope), resolve).context;
  return bridge.rewriteCandidate(candidate(models, id), context, resolve);
}
function history(value: Candidate, output?: unknown, conversationId = 'parent', responseId?: string): GeminiBody {
  return {
    ...parent(conversationId),
    contents: [
      ...parent().contents,
      value.content,
      ...(output === undefined
        ? []
        : [
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'invoke_subagent',
                    ...(responseId ? { id: responseId } : {}),
                    response: { output },
                  },
                },
              ],
            },
          ]),
    ],
  };
}

describe('subagent routing at the common Gemini boundary', () => {
  it('routes parallel Google calls without IDs before either parent has a result', () => {
    const bridge = new SubagentRoutingBridge();
    const a = spawn(bridge, ['custom-a'], 'parent-a');
    const b = spawn(bridge, ['custom-b'], 'parent-b');
    expect(call(a).id).toMatch(/^subagent_[0-9a-f]{32}$/);
    expect(call(a).id).not.toEqual(call(b).id);
    expect(call(a).args.Subagents[0].Model).toBe('inherit');
    expect(bridge.prepareRequest(child(prompt(a), 'child-a'), resolve).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(child(prompt(b), 'child-b'), resolve).modelName).toBe('custom-b');
    expect(bridge.prepareRequest(child(prompt(a), 'child-a'), resolve).body.contents[0].parts[0].text).toBe('Task 0');
  });

  it('keeps different children in one invocation paired with their own configured models', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'flash', 'custom-b']);
    expect(prompt(emitted, 1)).toBe('Task 1');
    expect(call(emitted).args.Subagents[1].Model).toBe('flash');
    expect(bridge.prepareRequest(child(prompt(emitted, 2), 'b'), resolve).modelName).toBe('custom-b');
    expect(bridge.prepareRequest(child(prompt(emitted), 'a'), resolve).modelName).toBe('custom-a');
  });

  it.each(['google', 'openai', 'anthropic'])(
    'restores intended Model and Prompt before replay through %s',
    (provider) => {
      const bridge = new SubagentRoutingBridge();
      const emitted = spawn(bridge, ['custom-b']);
      const original = structuredClone(emitted);
      const prepared = bridge.prepareRequest(history(emitted, JSON.stringify({ conversationId: 'child' })), resolve);
      expect(prepared.modelName).toBeUndefined();
      const restored = prepared.body.contents[1].parts[0].functionCall as ReturnType<typeof call>;
      expect(restored.args.Subagents[0]).toEqual({ Model: 'custom-b', Prompt: 'Task 0' });
      expect(restored.id).toBe(call(emitted).id);
      const response = prepared.body.contents[2].parts[0].functionResponse as { id: string };
      expect(response.id).toBe(restored.id);
      const upstream = translateRequest(provider, prepared.body, 'parent-model');
      expect(JSON.stringify(upstream)).toContain('custom-b');
      expect(JSON.stringify(upstream)).not.toContain('antigravity-subagent-route');
      expect(bridge.prepareRequest(child('Follow-up without the original prompt.', 'child'), resolve).modelName).toBe(
        'custom-b',
      );
      expect(emitted).toEqual(original);
    },
  );

  it('does not change a parent route merely because its history contains child markers', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const prepared = bridge.prepareRequest(history(emitted), resolve);
    expect(prepared.modelName).toBeUndefined();
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route');
  });

  it.each(['live', 'restarted', 'expired'] as const)(
    'cleans two quoted child snapshots after compaction with %s routing state',
    (state) => {
      let now = 0;
      const bridge = new SubagentRoutingBridge({ now: () => now, ttlMs: 100 });
      const emitted = spawn(bridge, ['custom-a', 'custom-b']);
      const snapshots = [0, 1].map((index) => JSON.stringify({ spec: { initialPrompt: prompt(emitted, index) } }));
      const body = child(`Earlier work:\n${snapshots.join('\n')}\nContinue the parent task.`, 'parent');
      const before = structuredClone(body);
      if (state === 'restarted') bridge.clear();
      if (state === 'expired') now = 101;
      const prepared = bridge.prepareRequest(body, resolve);
      expect(prepared.modelName).toBeUndefined();
      expect(prepared.body.contents[0].parts[0].text).toBe(
        'Earlier work:\n{"spec":{"initialPrompt":"Task 0"}}\n{"spec":{"initialPrompt":"Task 1"}}\nContinue the parent task.',
      );
      expect(body).toEqual(before);
    },
  );

  it('does not bind an unrelated conversation to a single quoted historical child', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const prepared = bridge.prepareRequest(
      child(`Previous child: '${JSON.stringify({ initialPrompt: prompt(emitted) })}'`, 'unrelated'),
      resolve,
    );
    expect(prepared.modelName).toBeUndefined();
    expect(prepared.body.contents[0].parts[0].text).toBe('Previous child: \'{"initialPrompt":"Task 0"}\'');
    expect(bridge.prepareRequest(child('Continue.', 'unrelated'), resolve).modelName).toBeUndefined();
    expect(bridge.prepareRequest(child(prompt(emitted), 'actual-child'), resolve).modelName).toBe('custom-a');
  });

  it('routes an active child marker alongside historical sibling snapshots', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b']);
    const snapshot = JSON.stringify({ spec: { initialPrompt: prompt(emitted, 1) } });
    const body = child(`${prompt(emitted)}\nPrior work: ${snapshot}`, 'actual-child');
    const prepared = bridge.prepareRequest(body, resolve);
    expect(prepared.modelName).toBe('custom-a');
    expect(prepared.body.contents[0].parts[0].text).toBe('Task 0\nPrior work: {"spec":{"initialPrompt":"Task 1"}}');
    expect(bridge.prepareRequest(child('Continue.', 'actual-child'), resolve).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(child(prompt(emitted, 1), 'sibling'), resolve).modelName).toBe('custom-b');
  });

  it('accepts historical snapshots in later user turns without changing an existing child binding', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b']);
    bridge.prepareRequest(child(prompt(emitted), 'bound-child'), resolve);
    const body = child('Compacted child context', 'bound-child');
    body.contents.push({
      role: 'user',
      parts: [{ text: `Review ${JSON.stringify({ initialPrompt: prompt(emitted, 1) })}` }],
    });
    expect(bridge.prepareRequest(body, resolve).modelName).toBe('custom-a');
    body.conversationId = 'ordinary-parent';
    expect(bridge.prepareRequest(body, resolve).modelName).toBeUndefined();
  });

  it('handles escaped JSON keys, quotes, backslashes and marker delimiters without altering surrounding text', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const task = 'Quoted "task" and path C:\\work\\project with {braces}';
    const json = JSON.stringify({ spec: { initialPrompt: prompt(emitted).replace('Task 0', task), keep: 'unchanged' } })
      .replace('initialPrompt', 'initial\\u0050rompt')
      .replace('[antigravity', '\\u005bantigravity');
    const prepared = bridge.prepareRequest(child(`Before\n${json}\nAfter`, 'parent'), resolve);
    expect(prepared.modelName).toBeUndefined();
    const text = prepared.body.contents[0].parts[0].text;
    expect(text).toBe(`Before\n{"spec":{"initial\\u0050rompt":${JSON.stringify(task)},"keep":"unchanged"}}\nAfter`);
  });

  it('preserves whitespace and duplicate unrelated JSON fields when cleaning a snapshot', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const text = `{ "keep": 1, "keep": 2, "initialPrompt" : ${JSON.stringify(prompt(emitted))} }`;
    expect(bridge.prepareRequest(child(text, 'parent'), resolve).body.contents[0].parts[0].text).toBe(
      '{ "keep": 1, "keep": 2, "initialPrompt" : "Task 0" }',
    );
  });

  it.each([
    (text: string) => JSON.stringify({ Prompt: text }),
    (text: string) => JSON.stringify({ initialPromptCopy: text }),
    (text: string) => JSON.stringify({ initialPrompt: { text } }),
    (text: string) => JSON.stringify({ prose: `"initialPrompt": ${JSON.stringify(text)}` }),
    (text: string) => `{"initialPrompt": ${JSON.stringify(text)},}`,
    (text: string) => `{"initialPrompt": ${JSON.stringify(text).replace('Task 0', 'Task \\q')}}`,
    (text: string) => `{'initialPrompt': '${text}'}`,
    (text: string) => `{"initialPrompt": ${JSON.stringify(text)}`,
  ])('keeps non-snapshot or invalid JSON markers subject to routing guards: %s', (serialize) => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const body = child(serialize(prompt(emitted)), 'parent');
    const before = structuredClone(body);
    expect(() => bridge.prepareRequest(body, resolve)).toThrow(/parent conversation/);
    expect(body).toEqual(before);
    bridge.clear();
    expect(() => bridge.prepareRequest(body, resolve)).toThrow(/expired or is unknown/);
  });

  it('keeps active unknown, conflicting, parent and assigned-route guards around valid snapshots', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b', 'custom-c']);
    const snapshot = JSON.stringify({ initialPrompt: prompt(emitted, 2) });
    expect(() =>
      bridge.prepareRequest(
        child(`${snapshot}\n[antigravity-subagent-route:11111111-1111-4111-8111-111111111111]`),
        resolve,
      ),
    ).toThrow(/expired or is unknown/);
    expect(() =>
      bridge.prepareRequest(child(`${snapshot}\n${prompt(emitted)}\n${prompt(emitted, 1)}`), resolve),
    ).toThrow(/Multiple/);
    expect(() => bridge.prepareRequest(child(`${snapshot}\n${prompt(emitted)}`, 'parent'), resolve)).toThrow(
      /parent conversation/,
    );
    bridge.prepareRequest(child(prompt(emitted), 'child-a'), resolve);
    expect(() => bridge.prepareRequest(child(`${snapshot}\n${prompt(emitted)}`, 'other-child'), resolve)).toThrow(
      /already assigned/,
    );
    const later = child('Initial ordinary prompt');
    later.contents.push({ role: 'user', parts: [{ text: `${snapshot}\n${prompt(emitted, 1)}` }] });
    expect(() => bridge.prepareRequest(later, resolve)).toThrow(/initial child prompt/);
  });

  it('does not inspect marker-looking strings inside function results for child routing', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const body: GeminiBody = {
      conversationId: 'other-parent',
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'read_file', response: { output: prompt(emitted) } } }],
        },
      ],
    };
    expect(bridge.prepareRequest(body, resolve).modelName).toBeUndefined();
  });

  it('uses the native cascade ID and keeps routing when the initial prompt is compacted away', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    expect(
      bridge.prepareRequest({ ...child(prompt(emitted)), labels: { cascade_id: 'cascade-a' } }, resolve).modelName,
    ).toBe('custom-a');
    expect(
      bridge.prepareRequest({ ...child('Next turn', 'unrelated'), labels: { cascade_id: 'cascade-a' } }, resolve)
        .modelName,
    ).toBe('custom-a');
    expect(bridge.prepareRequest(child('Next turn', 'child'), resolve).modelName).toBeUndefined();
  });

  it('never treats a shared session as a shared parent conversation', () => {
    const bridge = new SubagentRoutingBridge();
    const a = bridge.prepareRequest({ sessionId: 'same-session' }, resolve).context;
    const b = bridge.prepareRequest({ sessionId: 'same-session' }, resolve).context;
    expect(a.stable).toBe(false);
    expect(a.scope).not.toBe(b.scope);
  });

  it('supports initial routing with a prompt marker even when the client supplies no conversation ID', () => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest({}, resolve).context;
    const emitted = bridge.rewriteCandidate(candidate(['custom-a']), context, resolve);
    const body = child(prompt(emitted));
    delete body.conversationId;
    expect(bridge.prepareRequest(body, resolve).modelName).toBe('custom-a');
    expect(
      bridge.prepareRequest({ contents: [emitted.content] }, resolve).body.contents[0].parts[0].functionCall,
    ).toMatchObject({ args: { Subagents: [{ Model: 'custom-a', Prompt: 'Task 0' }] } });
  });

  it('preserves provider IDs but allocates a fresh ID if that provider reuses one in the same conversation', () => {
    const bridge = new SubagentRoutingBridge();
    const a = spawn(bridge, ['custom-a'], 'parent', 'provider-1');
    const b = spawn(bridge, ['custom-b'], 'parent', 'provider-1');
    expect(call(a).id).toBe('provider-1');
    expect(call(b).id).not.toBe('provider-1');
    expect(bridge.prepareRequest(child(prompt(a), 'a'), resolve).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(child(prompt(b), 'b'), resolve).modelName).toBe('custom-b');
  });

  it('scopes identical provider IDs to separate parents', () => {
    const bridge = new SubagentRoutingBridge();
    const a = spawn(bridge, ['custom-a'], 'parent-a', 'call-1');
    const b = spawn(bridge, ['custom-b'], 'parent-b', 'call-1');
    bridge.prepareRequest(history(a, { conversationId: 'a' }, 'parent-a', 'call-1'), resolve);
    bridge.prepareRequest(history(b, { conversationId: 'b' }, 'parent-b', 'call-1'), resolve);
    expect(bridge.prepareRequest(child('Next', 'a'), resolve).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(child('Next', 'b'), resolve).modelName).toBe('custom-b');
  });

  it('does not reuse a prior custom intent for a later builtin tier', () => {
    const bridge = new SubagentRoutingBridge();
    spawn(bridge, ['custom-b'], 'parent', 'reused');
    const builtin = spawn(bridge, ['pro'], 'parent', 'reused');
    const prepared = bridge.prepareRequest(history(builtin, { conversationId: 'native-child' }), resolve);
    expect(prepared.body.contents[1].parts[0].functionCall).toMatchObject({ args: { Subagents: [{ Model: 'pro' }] } });
    expect(bridge.prepareRequest(child('Native task', 'native-child'), resolve).modelName).toBeUndefined();
  });

  it('does not pair ambiguous missing-ID results to either outstanding call', () => {
    const bridge = new SubagentRoutingBridge();
    const a = spawn(bridge, ['custom-a']);
    const b = spawn(bridge, ['custom-b']);
    const replay = history(a, { conversationId: 'unknown-child' });
    replay.contents.splice(2, 0, b.content);
    bridge.prepareRequest(replay, resolve);
    expect(bridge.prepareRequest(child('No marker', 'unknown-child'), resolve).modelName).toBeUndefined();
  });

  it.each([
    [{ conversationId: 'only-one' }],
    [{ conversationId: 'duplicate' }, { conversationId: 'duplicate' }],
    [{ unexpected: { conversationId: 'nested-a' } }, { conversationId: 'nested-b' }],
  ])('does not bind incomplete, duplicate or nested result IDs: %j', (results) => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b']);
    bridge.prepareRequest(history(emitted, results), resolve);
    for (const id of ['only-one', 'duplicate', 'nested-a', 'nested-b'])
      expect(bridge.prepareRequest(child('Next', id), resolve).modelName).toBeUndefined();
  });

  it('does not extract child IDs from arbitrary tool prose', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    bridge.prepareRequest(history(emitted, 'Read this example: {"conversationId":"example-id"}'), resolve);
    expect(bridge.prepareRequest(child('Next', 'example-id'), resolve).modelName).toBeUndefined();
  });

  it('does not partially bind a spawn result when a later child ID conflicts', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b']);
    bridge.prepareRequest(child(prompt(emitted, 1), 'child-b'), resolve);
    expect(() =>
      bridge.prepareRequest(history(emitted, [{ conversationId: 'wrong-a' }, { conversationId: 'wrong-b' }]), resolve),
    ).toThrow(/already assigned/);
    expect(bridge.prepareRequest(child(prompt(emitted), 'correct-a'), resolve).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(child('No marker', 'wrong-a'), resolve).modelName).toBeUndefined();
  });

  it('rejects reordered spawn markers even when moved into a builtin entry', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'pro']);
    call(emitted).args.Subagents.reverse();
    expect(() => bridge.prepareRequest(history(emitted), resolve)).toThrow(/order of its spawn markers/);
  });

  it('rejects markers for unrelated or already assigned conversations', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    expect(() => bridge.prepareRequest(child(prompt(emitted), 'parent'), resolve)).toThrow(/parent conversation/);
    bridge.prepareRequest(child(prompt(emitted), 'child-a'), resolve);
    expect(() => bridge.prepareRequest(child(prompt(emitted), 'child-b'), resolve)).toThrow(/already assigned/);
  });

  it('rejects multiple distinct issued markers instead of choosing the first', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge, ['custom-a', 'custom-b']);
    expect(() => bridge.prepareRequest(child(`${prompt(emitted)}\n${prompt(emitted, 1)}`), resolve)).toThrow(
      /Multiple/,
    );
  });

  it('rejects marker reuse in a later ordinary user message', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    const body = child('Initial ordinary user prompt');
    body.contents.push({ role: 'user', parts: [{ text: prompt(emitted) }] });
    expect(() => bridge.prepareRequest(body, resolve)).toThrow(/initial child prompt/);
  });

  it('rejects an unissued child marker and does not mutate the caller body', () => {
    const bridge = new SubagentRoutingBridge();
    const body = child('Prompt\n\n[antigravity-subagent-route:11111111-1111-4111-8111-111111111111]');
    const before = structuredClone(body);
    expect(() => bridge.prepareRequest(body, resolve)).toThrow(SubagentRoutingError);
    expect(body).toEqual(before);
  });

  it('fails on expired child routes while allowing parent history to start a new child', () => {
    let now = 0;
    const bridge = new SubagentRoutingBridge({ now: () => now, ttlMs: 100 });
    const emitted = spawn(bridge);
    now = 101;
    expect(() => bridge.prepareRequest(child(prompt(emitted)), resolve)).toThrow(/expired/);
    const prepared = bridge.prepareRequest(history(emitted, { conversationId: 'old-child' }), resolve);
    expect(JSON.stringify(prepared.body)).not.toContain('antigravity-subagent-route');
    expect(bridge.prepareRequest(child('Next', 'old-child'), resolve).modelName).toBeUndefined();
    const fresh = bridge.rewriteCandidate(candidate(['custom-b']), prepared.context, resolve);
    expect(bridge.prepareRequest(child(prompt(fresh), 'new-child'), resolve).modelName).toBe('custom-b');
  });

  it('clears routing on shutdown/restart and cleans stale markers out of parent history', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    bridge.clear();
    expect(() => bridge.prepareRequest(child(prompt(emitted)), resolve)).toThrow(/expired or is unknown/);
    expect(JSON.stringify(bridge.prepareRequest(history(emitted), resolve).body)).not.toContain(
      'antigravity-subagent-route',
    );
  });

  it('rejects a known compacted child after expiry instead of silently using its native parent model', () => {
    let now = 0;
    const bridge = new SubagentRoutingBridge({ now: () => now, ttlMs: 100 });
    const emitted = spawn(bridge);
    bridge.prepareRequest(child(prompt(emitted)), resolve);
    now = 101;
    expect(() => bridge.prepareRequest(child('Compacted follow-up without marker'), resolve)).toThrow(
      /route has expired/,
    );
    expect(bridge.prepareRequest(parent(), resolve).modelName).toBeUndefined();
  });

  it('remembers an evicted compacted child scope without retaining its model route', () => {
    const bridge = new SubagentRoutingBridge({ maxEntries: 2 });
    const emitted = spawn(bridge);
    bridge.prepareRequest(child(prompt(emitted)), resolve);
    spawn(bridge, ['custom-b'], 'parent-b');
    spawn(bridge, ['custom-c'], 'parent-c');
    expect(() => bridge.prepareRequest(child('Compacted follow-up'), resolve)).toThrow(/route has expired/);
  });

  it('bounds saved routes and rejects evicted child markers', () => {
    const bridge = new SubagentRoutingBridge({ maxEntries: 2 });
    const first = spawn(bridge, ['custom-a'], 'p1');
    spawn(bridge, ['custom-b'], 'p2');
    const recent = spawn(bridge, ['custom-c'], 'p3');
    expect(() => bridge.prepareRequest(child(prompt(first)), resolve)).toThrow(/expired/);
    expect(bridge.prepareRequest(child(prompt(recent)), resolve).modelName).toBe('custom-c');
  });

  it('validates model availability on each child turn but permits historical parent replay', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    bridge.prepareRequest(child(prompt(emitted)), resolve);
    expect(() => bridge.prepareRequest(child('Next turn'), () => undefined)).toThrow(/enabled configured/);
    expect(
      bridge.prepareRequest(history(emitted), () => undefined).body.contents[1].parts[0].functionCall,
    ).toMatchObject({ args: { Subagents: [{ Model: 'custom-a' }] } });
  });

  it('does not redirect a deleted canonical model name to an alias of a different model', () => {
    const bridge = new SubagentRoutingBridge();
    const emitted = spawn(bridge);
    expect(() => bridge.prepareRequest(child(prompt(emitted)), () => 'custom-b')).toThrow(
      /configured subagent model has changed/,
    );
  });

  it('fails unknown custom selectors visibly before emitting inherit or creating a route', () => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent(), resolve).context;
    const value = candidate(['unconfigured']);
    expect(() => bridge.rewriteCandidate(value, context, resolve)).toThrow(/enabled configured/);
    expect(call(value).args.Subagents[0].Model).toBe('unconfigured');
  });

  it.each(['inherit', undefined])('routes nested %s spawns to the actual effective parent model', (selection) => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent('routed-parent'), resolve).context;
    context.modelName = 'custom-b';
    const emitted = bridge.rewriteCandidate(candidate([selection]), context, resolve);
    expect(bridge.prepareRequest(child(prompt(emitted), 'grandchild'), resolve).modelName).toBe('custom-b');
    const restored = bridge.prepareRequest(history(emitted, undefined, 'routed-parent'), resolve).body;
    const args = (restored.contents[1].parts[0].functionCall as ReturnType<typeof call>).args;
    expect(args.Subagents[0].Model).toBe(selection);
  });

  it.each(['flash_lite', 'flash', 'pro'])('keeps explicit builtin %s without an inherited custom override', (tier) => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent(), resolve).context;
    context.modelName = 'custom-b';
    const emitted = bridge.rewriteCandidate(candidate([tier]), context, resolve);
    expect(call(emitted).args.Subagents[0]).toEqual({ Model: tier, Prompt: 'Task 0' });
  });

  it('keeps an exact saved selector in history when initial resolution used an alias', () => {
    const bridge = new SubagentRoutingBridge();
    const resolver = (name: string) => (name === 'catalog-alias' ? 'custom-a' : resolve(name));
    const context = bridge.prepareRequest(parent(), resolver).context;
    const emitted = bridge.rewriteCandidate(candidate(['catalog-alias']), context, resolver);
    expect(bridge.prepareRequest(child(prompt(emitted)), resolver).modelName).toBe('custom-a');
    expect(bridge.prepareRequest(history(emitted), resolver).body.contents[1].parts[0].functionCall).toMatchObject({
      args: { Subagents: [{ Model: 'catalog-alias' }] },
    });
  });

  it('relaxes only invoke_subagent Model declarations on a copy for every provider', () => {
    const bridge = new SubagentRoutingBridge();
    const schema = {
      type: 'object',
      properties: {
        Subagents: {
          type: 'array',
          items: {
            type: 'object',
            properties: { Model: { type: 'string', enum: ['inherit', 'pro'] }, Prompt: { type: 'string' } },
          },
        },
      },
    };
    const body: GeminiBody = {
      ...parent(),
      tools: [
        {
          functionDeclarations: [
            { name: 'invoke_subagent', parametersJsonSchema: schema },
            { name: 'other_tool', parameters: schema },
          ],
        },
      ],
    };
    const before = JSON.stringify(body);
    const prepared = bridge.prepareRequest(body, resolve).body;
    const tools = prepared.tools as {
      functionDeclarations: { parametersJsonSchema?: typeof schema; parameters?: typeof schema }[];
    }[];
    expect(
      tools[0].functionDeclarations[0].parametersJsonSchema.properties.Subagents.items.properties.Model.enum,
    ).toBeUndefined();
    expect(tools[0].functionDeclarations[1].parameters.properties.Subagents.items.properties.Model.enum).toEqual([
      'inherit',
      'pro',
    ]);
    expect(JSON.stringify(body)).toBe(before);
    for (const format of ['google', 'openai', 'anthropic'])
      expect(JSON.stringify(translateRequest(format, prepared, 'parent-model'))).toContain('exact saved name');
  });

  it('rewrites nonstream candidates and preserves ordinary content and metadata', () => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent(), resolve).context;
    const response = { candidates: [candidate(['custom-a'])], usageMetadata: { totalTokenCount: 10 } };
    const output = bridge.rewriteResponse(response, context, resolve);
    expect(output.usageMetadata).toEqual(response.usageMetadata);
    expect(call(output.candidates[0]).args.Subagents[0].Model).toBe('inherit');
    expect(call(response.candidates[0]).args.Subagents[0].Model).toBe('custom-a');
    expect(bridge.rewriteCandidate({ content: { parts: [{ text: 'ordinary' }] } }, context, resolve)).toEqual({
      content: { parts: [{ text: 'ordinary' }] },
    });
  });

  it('reuses the same bridge marker when a provider repeats its identified final call', () => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent(), resolve).context;
    const first = bridge.rewriteCandidate(candidate(['custom-a'], 'call-1'), context, resolve);
    const repeated = bridge.rewriteCandidate(candidate(['custom-a'], 'call-1'), context, resolve);
    expect(repeated).toEqual(first);
  });

  it('relaxes flat invoke_subagent Model declarations directly on parameters.properties.Model', () => {
    const bridge = new SubagentRoutingBridge();
    const flatSchema = {
      type: 'object',
      properties: {
        Model: { type: 'string', enum: ['inherit', 'flash_lite', 'flash', 'pro'] },
        Prompt: { type: 'string' },
        Role: { type: 'string' },
        TypeName: { type: 'string' },
      },
      required: ['TypeName', 'Role', 'Prompt'],
    };
    const body: GeminiBody = {
      ...parent(),
      tools: [
        {
          functionDeclarations: [
            { name: 'invoke_subagent', parameters: flatSchema },
          ],
        },
      ],
    };
    const prepared = bridge.prepareRequest(body, resolve).body;
    const tools = prepared.tools as {
      functionDeclarations: { parameters?: typeof flatSchema }[];
    }[];
    expect(tools[0].functionDeclarations[0].parameters.properties.Model.enum).toBeUndefined();
    expect(tools[0].functionDeclarations[0].parameters.properties.Model.description).toContain('exact saved name');
  });

  it('rewrites and routes flat invoke_subagent tool calls and restores history', () => {
    const bridge = new SubagentRoutingBridge();
    const context = bridge.prepareRequest(parent(), resolve).context;
    const flatCall = {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'invoke_subagent',
              args: {
                TypeName: 'research',
                Role: 'Researcher',
                Model: 'custom-a',
                Prompt: 'Perform deep research',
              },
            },
          },
        ],
      },
    };
    const rewritten = bridge.rewriteCandidate(flatCall, context, resolve);
    const rewrittenCall = rewritten.content.parts[0].functionCall as {
      name: string;
      args: { Model: string; Prompt: string; TypeName: string; Role: string };
    };
    // The emitted Model must be rewritten to 'inherit' so Antigravity validator does not reject it
    expect(rewrittenCall.args.Model).toBe('inherit');
    expect(rewrittenCall.args.Prompt).toContain('Perform deep research');
    expect(rewrittenCall.args.Prompt).toContain('[antigravity-subagent-route:');

    // Child initial prompt routes to the custom model
    const childReq = child(rewrittenCall.args.Prompt);
    const childPrepared = bridge.prepareRequest(childReq, resolve);
    expect(childPrepared.modelName).toBe('custom-a');
    expect(childPrepared.body.contents[0].parts[0].text).toBe('Perform deep research');

    // History replay restores the custom Model so parent does not retry
    const historyBody: GeminiBody = {
      ...parent(),
      contents: [
        ...parent().contents,
        rewritten.content,
      ],
    };
    const restored = bridge.prepareRequest(historyBody, resolve);
    const restoredCall = restored.body.contents[1].parts[0].functionCall as {
      args: { Model: string; Prompt: string };
    };
    expect(restoredCall.args.Model).toBe('custom-a');
    expect(restoredCall.args.Prompt).toBe('Perform deep research');
  });
});
