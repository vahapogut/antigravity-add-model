/**
 * Typed planner for the native Windows Language Server model-catalogue fix.
 * It only edits a copied Buffer after the caller explicitly opts in; callers
 * remain responsible for transactional installation and backup/rollback.
 */

export const ORIGINAL_LANGUAGE_SERVER_URL = Buffer.from('https://daily-cloudcode-pa.googleapis.com');
export const PATCHED_LANGUAGE_SERVER_URL = Buffer.from('http://localhost:50999/v1internal/xxxxxxx');

export type LanguageServerEndpointMode = 'fixed' | 'dynamic' | 'unknown';

type BinaryPatchErrorCode = 'BINARY_NOT_FOUND' | 'BINARY_NOT_SUPPORTED';

type BinaryPatchError = Error & { code?: BinaryPatchErrorCode };

export interface LanguageServerBinaryPlan {
  mode: LanguageServerEndpointMode;
  /** Patched bytes only when the explicit patch option changed the input. */
  bytes: Buffer | null;
}

function fail(code: BinaryPatchErrorCode, message: string): never {
  const error = new Error(`${code}: ${message}`) as BinaryPatchError;
  error.code = code;
  throw error;
}

/**
 * Classify the recognized endpoint in a Windows Language Server executable.
 * When `requested` is true, replace every equal-length vendor URL occurrence
 * in a copied PE buffer. Unknown layouts are rejected rather than guessed.
 */
export function planLanguageServerBinary(
  input: Buffer | null,
  requested: boolean,
): LanguageServerBinaryPlan {
  if (input === null) {
    if (requested) {
      fail('BINARY_NOT_FOUND', '--patch-language-server requires resources/bin/language_server.exe.');
    }
    return { mode: 'unknown', bytes: null };
  }

  const originalFound = input.includes(ORIGINAL_LANGUAGE_SERVER_URL);
  const patchedFound = input.includes(PATCHED_LANGUAGE_SERVER_URL);

  if (requested) {
    if (
      input[0] !== 0x4d ||
      input[1] !== 0x5a ||
      ORIGINAL_LANGUAGE_SERVER_URL.length !== PATCHED_LANGUAGE_SERVER_URL.length ||
      (!originalFound && !patchedFound)
    ) {
      fail(
        'BINARY_NOT_SUPPORTED',
        'Expected a Windows PE language server with the recognized Cloud Code endpoint. No binary was changed.',
      );
    }

    if (originalFound) {
      // Never mutate the caller's source buffer: deployment writes this candidate
      // only after all preflight and backup checks have succeeded.
      const bytes = Buffer.from(input);
      let offset = 0;
      while ((offset = bytes.indexOf(ORIGINAL_LANGUAGE_SERVER_URL, offset)) !== -1) {
        PATCHED_LANGUAGE_SERVER_URL.copy(bytes, offset);
        offset += PATCHED_LANGUAGE_SERVER_URL.length;
      }
      return { mode: 'fixed', bytes };
    }
  }

  return { mode: patchedFound ? 'fixed' : originalFound ? 'dynamic' : 'unknown', bytes: null };
}
