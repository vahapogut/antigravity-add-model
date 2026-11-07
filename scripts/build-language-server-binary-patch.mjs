#!/usr/bin/env node
// Type-check and emit the small typed planner used by the bootstrap installer.
// The emitted .mjs is checked in so read-only update diagnostics work before a build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'language-server-binary-patch.ts');
const outputPath = path.join(directory, 'language-server-binary-patch.mjs');
const program = ts.createProgram([sourcePath], {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: ['node'],
  typeRoots: [path.join(directory, '../node_modules/@types')],
  skipLibCheck: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: process.cwd,
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
} else {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  fs.writeFileSync(outputPath, output.endsWith('\n') ? output : `${output}\n`);
  process.stdout.write(`Generated ${path.relative(process.cwd(), outputPath)}\n`);
}
