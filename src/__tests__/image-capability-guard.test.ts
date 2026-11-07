import { describe, expect, it } from 'vitest';
import { mapGeminiToOpenAI } from '../proxy/translators/openai';
import { mapGeminiToAnthropic } from '../proxy/translators/anthropic';
import { omitUnsupportedToolImages } from '../proxy/translators/images';
import { detectModelCapabilities } from '../proxy/modelUtils';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
type GeminiRequest = Parameters<typeof mapGeminiToOpenAI>[0];
type Content = NonNullable<GeminiRequest['contents']>[number];

function toolResultTurn(parts: Record<string, unknown>[]): Content[] {
  return [
    { role: 'user', parts: [{ text: 'Read the screenshot.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file', id: 'c1', args: { Path: 's.png' } } }] },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            id: 'c1',
            response: { Output: 'Showing binary file of type image/png' },
            parts,
          },
        },
      ],
    },
  ] as Content[];
}

const nestedImage = () => [{ inlineData: { mimeType: 'image/png', data: PNG } }];

describe('omitUnsupportedToolImages', () => {
  it('returns the identical body for a vision-capable model', () => {
    const body = { contents: toolResultTurn(nestedImage()) } as GeminiRequest;
    expect(omitUnsupportedToolImages(body, true)).toBe(body);
  });

  it('returns the identical body when there is nothing to strip', () => {
    const body = { contents: toolResultTurn([{ text: 'plain output' }]) } as GeminiRequest;
    expect(omitUnsupportedToolImages(body, false)).toBe(body);
  });

  it('replaces a nested tool image with a placeholder for a text-only model', () => {
    const body = { contents: toolResultTurn(nestedImage()) } as GeminiRequest;
    const result = omitUnsupportedToolImages(body, false);
    expect(JSON.stringify(result)).not.toContain(PNG);
    expect(JSON.stringify(result)).toContain('Image omitted');
    // The tool response itself must survive so the model still learns the call happened.
    expect(JSON.stringify(result)).toContain('Showing binary file of type image/png');
    // The original body must not be mutated.
    expect(JSON.stringify(body)).toContain(PNG);
  });

  it('emits exactly one placeholder for a tool response carrying several images', () => {
    const body = {
      contents: toolResultTurn([
        { inlineData: { mimeType: 'image/png', data: PNG } },
        { inlineData: { mimeType: 'image/jpeg', data: PNG } },
      ]),
    } as GeminiRequest;
    const result = omitUnsupportedToolImages(body, false);
    expect(JSON.stringify(result).match(/Image omitted/g)).toHaveLength(1);
  });

  it('strips a mime-declared fileData and a data-URL image', () => {
    const body = {
      contents: toolResultTurn([
        { fileData: { mimeType: 'image/png', fileUri: 'https://x/y.png' } },
        { fileData: { fileUri: 'data:image/png;base64,' + PNG } },
      ]),
    } as GeminiRequest;
    const result = JSON.stringify(omitUnsupportedToolImages(body, false));
    expect(result).not.toContain('https://x/y.png');
    expect(result).not.toContain(PNG);
    expect(result).toContain('Image omitted');
  });

  it('does not modify non-image attachments or nested text parts', () => {
    const body = {
      contents: toolResultTurn([{ text: 'not an image' }, { inlineData: { mimeType: 'text/plain', data: 'aGk=' } }]),
    } as GeminiRequest;
    expect(omitUnsupportedToolImages(body, false)).toBe(body);
  });

  // The compatibility guarantee that matters: the fix must not change the outcome
  // for anything that already worked before it.
  it('leaves a top-level user image alone, even for a text-only model', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] }],
    } as GeminiRequest;
    expect(omitUnsupportedToolImages(body, false)).toBe(body);
    expect(JSON.stringify(mapGeminiToOpenAI(body, 'x'))).toContain('image_url');
  });

  it('never yields image bytes in either translated wire format once stripped', () => {
    const body = omitUnsupportedToolImages({ contents: toolResultTurn(nestedImage()) } as GeminiRequest, false);
    for (const translated of [mapGeminiToOpenAI(body, 'x'), mapGeminiToAnthropic(body, 'x')]) {
      const serialized = JSON.stringify(translated.messages);
      expect(serialized).not.toContain('image_url');
      expect(serialized).not.toContain('"type":"image"');
      expect(serialized).not.toContain(PNG);
      expect(serialized).toContain('Image omitted');
    }
  });
});

describe('capability detection driving the guard', () => {
  it('treats an unlisted model without a vision hint as text-only', () => {
    // Unknown models stay text-only: forwarding an image to them hard-fails upstream.
    expect(detectModelCapabilities({ name: 'models/acme-txt-1', provider: 'openrouter' } as never).supportsImages).toBe(
      false,
    );
  });

  it.each([
    [{ name: 'models/deepseek-flash', provider: 'openrouter' }, true],
    [{ name: 'models/deepseek-v4.1-flash', provider: 'openrouter' }, true],
    // Unlike DeepSeek, MiMo has no name pattern: vision must be declared explicitly.
    [{ name: 'models/mimo-v2-6-pro', provider: 'openrouter' }, false],
    [{ name: 'models/mimo-v2-6-pro', provider: 'openrouter', supportsVision: true }, true],
    [{ name: 'models/x', provider: 'openrouter', supportsVision: true }, true],
    [{ name: 'models/y', provider: 'anthropic' }, true],
    [{ name: 'models/z', provider: 'google' }, true],
  ])('detects vision support for %j', (model, expected) => {
    expect(detectModelCapabilities(model as never).supportsImages).toBe(expected);
  });

  // The name patterns miss several real vision models. That is exactly why the
  // guard is scoped to tool-result media only: a false negative here must never
  // start stripping images the pre-fix proxy forwarded successfully.
  it.each(['gpt-4.1-mini', 'gpt-5', 'o4-mini', 'llama-4-scout', 'qwen2.5-vl-7b', 'glm-4v', 'gemma3:12b'])(
    'reports no vision support for %s, so top-level images must stay untouched',
    (name) => {
      expect(detectModelCapabilities({ name, provider: 'openrouter' } as never).supportsImages).toBe(false);
    },
  );
});
