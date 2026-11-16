#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcNormDir = path.join(rootDir, 'src', 'norm');
const distNormDir = path.join(rootDir, 'dist', 'norm');

/** The Norm_Modules that the compiled CommonJS code resolves from dist/norm/. */
export const NORM_MODULES = Object.freeze([
  'catalogResolver.mjs',
  'requestMutator.mjs',
  'streamTransformer.mjs',
  'ideAutoPatcher.mjs',
]);

function causeOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies each Norm_Module byte-for-byte from srcDir to destDir, overwriting existing files.
 * Throws an Error naming the first file that could not be copied.
 */
export function copyNormModules({ srcDir = srcNormDir, destDir = distNormDir } = {}) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to copy ${NORM_MODULES[0]}: cannot create ${destDir}: ${causeOf(error)}`, {
      cause: error,
    });
  }
  for (const name of NORM_MODULES) {
    try {
      fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    } catch (error) {
      throw new Error(`Failed to copy ${name}: ${causeOf(error)}`, { cause: error });
    }
  }
  return [...NORM_MODULES];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const copied = copyNormModules();
    console.log(`[OmniNorm] Copied ${copied.length} module(s) to dist/norm: ${copied.join(', ')}`);
  } catch (error) {
    console.error(`[OmniNorm] ${causeOf(error)}`);
    process.exitCode = 1;
  }
}
