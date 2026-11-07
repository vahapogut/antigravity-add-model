import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_LANGUAGE_SERVER_URL,
  PATCHED_LANGUAGE_SERVER_URL,
  planLanguageServerBinary,
} from '../../scripts/language-server-binary-patch.mjs';

function pe(...parts: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x4d, 0x5a, 0]), ...parts]);
}

function occurrences(buffer: Buffer, needle: Buffer): number {
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

describe('Windows language-server endpoint patch planner', () => {
  it('keeps the binary URL replacement equal-length', () => {
    expect(ORIGINAL_LANGUAGE_SERVER_URL.length).toBe(PATCHED_LANGUAGE_SERVER_URL.length);
  });

  it('patches every recognized endpoint in a copied PE buffer', () => {
    const input = pe(ORIGINAL_LANGUAGE_SERVER_URL, Buffer.from([0]), ORIGINAL_LANGUAGE_SERVER_URL);
    const original = Buffer.from(input);
    const plan = planLanguageServerBinary(input, true);

    expect(plan.mode).toBe('fixed');
    expect(plan.bytes).not.toBeNull();
    expect(plan.bytes?.length).toBe(input.length);
    expect(occurrences(plan.bytes!, PATCHED_LANGUAGE_SERVER_URL)).toBe(2);
    expect(occurrences(plan.bytes!, ORIGINAL_LANGUAGE_SERVER_URL)).toBe(0);
    expect(input).toEqual(original);
  });

  it('detects an unpatched endpoint without changing it when patching was not requested', () => {
    const input = pe(ORIGINAL_LANGUAGE_SERVER_URL);
    const plan = planLanguageServerBinary(input, false);

    expect(plan).toEqual({ mode: 'dynamic', bytes: null });
    expect(input.includes(ORIGINAL_LANGUAGE_SERVER_URL)).toBe(true);
  });

  it('recognizes an already patched binary without rewriting it', () => {
    const input = pe(PATCHED_LANGUAGE_SERVER_URL);
    expect(planLanguageServerBinary(input, true)).toEqual({ mode: 'fixed', bytes: null });
  });

  it('refuses missing and unknown binaries when explicit patching is requested', () => {
    expect(planLanguageServerBinary(null, false)).toEqual({ mode: 'unknown', bytes: null });
    expect(() => planLanguageServerBinary(null, true)).toThrow('BINARY_NOT_FOUND');

    const unknown = pe(Buffer.from('unknown endpoint'));
    const original = Buffer.from(unknown);
    expect(() => planLanguageServerBinary(unknown, true)).toThrow('BINARY_NOT_SUPPORTED');
    expect(unknown).toEqual(original);
  });

  it('rejects a non-PE buffer even if it contains the expected URL', () => {
    const input = Buffer.concat([Buffer.from('not-a-pe:'), ORIGINAL_LANGUAGE_SERVER_URL]);
    expect(() => planLanguageServerBinary(input, true)).toThrow('BINARY_NOT_SUPPORTED');
    expect(input.includes(ORIGINAL_LANGUAGE_SERVER_URL)).toBe(true);
  });
});
