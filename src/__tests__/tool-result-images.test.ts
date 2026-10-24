import { describe, expect, it } from 'vitest';
import { mapGeminiToOpenAI } from '../proxy/translators/openai';
import { mapGeminiToAnthropic } from '../proxy/translators/anthropic';
import { trimContext, type GeminiBody } from '../proxy/requestOptions';

// A real one-pixel PNG. Tool results carry the same bytes the language server reads from disk.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const imageUrl = 'https://example.com/screenshot.png?version=2';
type GeminiRequest = Parameters<typeof mapGeminiToOpenAI>[0];
type Content = NonNullable<GeminiRequest['contents']>[number];

/**
 * The Antigravity language server reports media from tool executions as
 * `functionResponse.parts[].inlineData` (or `fileData`), because the response
 * payload itself is a JSON Struct and cannot hold image bytes. These parts must
 * reach the provider as native images rather than being silently dropped.
 */
function toolResultTurn(parts: Record<string, unknown>[]): Content[] {
  return [
    { role: 'user', parts: [{ text: 'Read the screenshot.' }] },
    {
      role: 'model',
      parts: [{ functionCall: { name: 'read_file', id: 'call_shot', args: { Path: 'shot.png' } } }],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            id: 'call_shot',
            response: { Path: 'shot.png', Output: 'Showing binary file of type image/png' },
            parts,
          },
        },
      ],
    },
  ] as Content[];
}

describe.each(['openai', 'anthropic'] as const)('%s tool-result image translation', (format) => {
  const translate = (contents: Content[]) =>
    format === 'openai'
      ? mapGeminiToOpenAI({ contents }, 'deepseek-flash')
      : mapGeminiToAnthropic({ contents }, 'deepseek-flash');
  const expectedInline = () =>
    format === 'openai'
      ? { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
  const expectedUrl = () =>
    format === 'openai'
      ? { type: 'image_url', image_url: { url: imageUrl } }
      : { type: 'image', source: { type: 'url', url: imageUrl } };

  /** Collect the image blocks from a translated request, in order. */
  const imagesOf = (messages: { content: unknown }[]) =>
    messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block: { type?: string }) => block.type === 'image_url' || block.type === 'image');

  it('forwards an inline image nested in a function response as a native image', () => {
    const contents = toolResultTurn([{ inlineData: { mimeType: 'image/png', data: PNG } }]);
    expect(imagesOf(translate(contents).messages)).toEqual([expectedInline()]);
  });

  it('forwards a file-data image nested in a function response as a native image', () => {
    const contents = toolResultTurn([{ fileData: { mimeType: 'image/png', fileUri: imageUrl } }]);
    expect(imagesOf(translate(contents).messages)).toEqual([expectedUrl()]);
  });

  it('keeps the tool response text next to the image it produced', () => {
    const contents = toolResultTurn([{ inlineData: { mimeType: 'image/png', data: PNG } }]);
    const messages = translate(contents).messages;
    const serialized = JSON.stringify(messages);
    // The tool summary must survive; the image is additive, not a replacement.
    expect(serialized).toContain('Showing binary file of type image/png');
    expect(imagesOf(messages)).toHaveLength(1);
  });

  it('preserves several images and their order across parallel tool results', () => {
    const contents = toolResultTurn([
      { inlineData: { mimeType: 'image/png', data: PNG } },
      { fileData: { mimeType: 'image/png', fileUri: imageUrl } },
    ]);
    expect(imagesOf(translate(contents).messages)).toEqual([expectedInline(), expectedUrl()]);
  });

  it('rejects unsupported nested image formats instead of dropping them', () => {
    const contents = toolResultTurn([{ inlineData: { mimeType: 'image/svg+xml', data: 'private-svg-content' } }]);
    expect(() => translate(contents)).toThrow('Unsupported image format. Use JPEG, PNG, GIF, or WebP.');
  });

  it('does not treat a plain nested text part as an image', () => {
    const contents = toolResultTurn([{ text: 'Not an image.' }]);
    const messages = translate(contents).messages;
    expect(imagesOf(messages)).toEqual([]);
    expect(JSON.stringify(messages)).toContain('Not an image.');
  });
});

describe('tool-result image context budgeting', () => {
  it('budgets images nested in a function response independently of base64 size', () => {
    const body = { contents: toolResultTurn([{ inlineData: { mimeType: 'image/png', data: 'a'.repeat(400_000) } }]) };
    // A raw base64 budget would blow 30k tokens; the image must cost a fixed estimate.
    expect(trimContext(body as GeminiBody, 30_000).contents).toEqual(body.contents);
  });

  it('still drops the whole tool exchange when it genuinely exceeds the budget', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'x'.repeat(60_000) }] },
        ...toolResultTurn([{ inlineData: { mimeType: 'image/png', data: PNG } }]),
      ],
    };
    expect(trimContext(body as GeminiBody, 6000).contents).toHaveLength(3);
  });
});
