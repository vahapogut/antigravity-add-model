// Build a narrowly scoped patch without evaluating any vendor or build code.
import { Script } from 'node:vm';
import ts from 'typescript';

const MARKER = '/* antigravity-model-patch: vendor-runtime-v1 */';
const LOCAL_URL = '__antigravityModelPatchUrl';

function unsupported(file, reason) {
  const error = new Error(
    `UNSUPPORTED_RUNTIME: ${file}: ${reason}. No application files changed. ` +
      'If an older patch replaced the runtime without a verified original backup, reinstall a clean vendor build.',
  );
  error.code = 'UNSUPPORTED_RUNTIME';
  throw error;
}

function parse(file, bytes, allowMarker = false) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (!allowMarker && source.includes(MARKER)) {
    unsupported(file, 'already patched; use the verified original archive for this version');
  }
  try {
    new Script(source, { filename: file });
  } catch (error) {
    unsupported(file, `invalid JavaScript (${error.message})`);
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (!allowMarker && file.startsWith('dist/')) {
    for (const call of matching(tree, ts.isCallExpression)) {
      const target = call.expression;
      if (
        ts.isIdentifier(target) &&
        target.text === 'require' &&
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        /^\.\/(?:proxy(?:\.js)?$|modelPatch\/)/.test(call.arguments[0].text)
      ) {
        unsupported(file, 'found an existing model proxy patch instead of a clean vendor runtime');
      }
      const method = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)
          ? target.argumentExpression.text
          : '';
      if (method === 'onBeforeRequest') {
        unsupported(file, 'an existing onBeforeRequest listener would conflict with the model proxy interceptor');
      }
    }
  }
  return { source, tree };
}

function readInput(readFile, filename) {
  let bytes;
  try {
    bytes = readFile(filename);
  } catch (error) {
    unsupported(filename, `cannot read required runtime file (${error?.message || String(error)})`);
  }
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
    unsupported(filename, 'required runtime file did not return Buffer or string contents');
  }
  return bytes;
}

function matching(root, predicate) {
  const nodes = [];
  function visit(node) {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return nodes;
}

function one(file, nodes, label) {
  if (nodes.length !== 1) unsupported(file, `expected exactly one ${label}, found ${nodes.length}`);
  return nodes[0];
}

function applyEdits(file, source, edits) {
  for (const { start, end = start, text } of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  parse(file, source, true);
  return Buffer.from(source);
}

function patchMain(bytes, userDataDir) {
  const file = 'dist/main.js';
  const { source, tree } = parse(file, bytes);
  const ready = one(
    file,
    matching(
      tree,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'whenReady',
    ),
    'app.whenReady() startup hook',
  );
  const receiver = ready.expression.expression;
  if (ready.arguments.length || !ts.isPropertyAccessExpression(receiver) || receiver.name.text !== 'app') {
    unsupported(file, 'unrecognized app.whenReady() receiver');
  }
  let statement = ready;
  while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
  if (!ts.isExpressionStatement(statement)) unsupported(file, 'startup hook must be a top-level expression');
  // Do not inject into a callback/function declaration merely containing whenReady().
  for (let node = ready.parent; node !== statement; node = node.parent) {
    if (ts.isFunctionLike(node)) unsupported(file, 'startup hook is nested inside a function');
  }
  // Separate profile (and single-instance lock) for a macOS clone. It must run before the vendor module starts,
  // and a prepended directive keeps the file's own "use strict" in effect.
  const profileEdit = userDataDir
    ? [
        {
          start: 0,
          text: `"use strict";\n{ const profile = ${JSON.stringify(userDataDir)}; require('node:fs').mkdirSync(profile, { recursive: true, mode: 0o700 }); require('electron').app.setPath('userData', profile); }\n`,
        },
      ]
    : [];
  return applyEdits(file, source, [
    ...profileEdit,
    {
      start: statement.getStart(tree),
      text: `${MARKER}\nrequire('./modelPatch/desktop').install(() => require('./languageServer').getLsPort());\n`,
    },
  ]);
}

// Newer desktop builds share base flags with other launchers. Inspect that
// module without evaluating it, then override only this launcher's local args.
function validateSharedLsArgs(readVendorFile, serverTree, spread) {
  const file = 'dist/languageServer.js';
  const call = spread.expression;
  const callee = ts.isCallExpression(call) && call.expression;
  const pair = callee && ts.isParenthesizedExpression(callee) && callee.expression;
  const target = pair && ts.isBinaryExpression(pair) && pair.right;
  if (
    !pair ||
    !ts.isBinaryExpression(pair) ||
    pair.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    !ts.isNumericLiteral(pair.left) ||
    pair.left.text !== '0' ||
    !target ||
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== 'baseLsArgs' ||
    !ts.isIdentifier(target.expression) ||
    call.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(call.arguments[0])
  )
    unsupported(file, 'spread must call the imported baseLsArgs helper');
  const binding = one(
    file,
    matching(
      serverTree,
      (node) =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === target.expression.text,
    ),
    'lsDefaults import',
  );
  const imported = binding.initializer;
  if (
    !imported ||
    !ts.isCallExpression(imported) ||
    !ts.isIdentifier(imported.expression) ||
    imported.expression.text !== 'require' ||
    imported.arguments.length !== 1 ||
    !ts.isStringLiteral(imported.arguments[0]) ||
    imported.arguments[0].text !== './lsDefaults' ||
    binding.parent.parent.parent !== serverTree
  )
    unsupported(file, 'baseLsArgs must come from a top-level require of ./lsDefaults');

  const defaultsFile = 'dist/lsDefaults.js';
  const { tree } = parse(defaultsFile, readInput(readVendorFile, defaultsFile));
  const helper = one(
    defaultsFile,
    matching(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'baseLsArgs'),
    'baseLsArgs function',
  );
  const exportedProperty = (node, name) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'exports' &&
    node.name.text === name;
  const assignments = (name) =>
    matching(
      tree,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        exportedProperty(node.left, name),
    );
  const exportedHelper = one(defaultsFile, assignments('baseLsArgs'), 'baseLsArgs export');
  if (
    !ts.isIdentifier(exportedHelper.right) ||
    exportedHelper.right.text !== 'baseLsArgs' ||
    !ts.isExpressionStatement(exportedHelper.parent) ||
    exportedHelper.parent.parent !== tree
  )
    unsupported(defaultsFile, 'baseLsArgs must export the inspected helper');
  if (
    helper.parent !== tree ||
    !helper.body ||
    helper.asteriskToken ||
    helper.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    helper.parameters.length !== 1 ||
    !ts.isIdentifier(helper.parameters[0].name) ||
    helper.parameters[0].initializer ||
    helper.parameters[0].dotDotDotToken ||
    helper.body.statements.length !== 1 ||
    !ts.isReturnStatement(helper.body.statements[0]) ||
    !helper.body.statements[0].expression ||
    !ts.isArrayLiteralExpression(helper.body.statements[0].expression)
  )
    unsupported(defaultsFile, 'baseLsArgs must return a literal args array');
  const elements = helper.body.statements[0].expression.elements;
  const opts = helper.parameters[0].name.text;
  // The only spread in the inspected helper is its optional legacy CSRF flag.
  for (const element of elements.filter(ts.isSpreadElement)) {
    const value = element.expression;
    const conditional = ts.isParenthesizedExpression(value) && value.expression;
    const property = (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === opts &&
      node.name.text === 'csrfToken';
    if (
      !conditional ||
      !ts.isConditionalExpression(conditional) ||
      !ts.isBinaryExpression(conditional.condition) ||
      !property(conditional.condition.left) ||
      conditional.condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      !ts.isIdentifier(conditional.condition.right) ||
      conditional.condition.right.text !== 'undefined' ||
      !ts.isArrayLiteralExpression(conditional.whenTrue) ||
      conditional.whenTrue.elements.length !== 2 ||
      !ts.isStringLiteral(conditional.whenTrue.elements[0]) ||
      conditional.whenTrue.elements[0].text !== '--csrf_token' ||
      !property(conditional.whenTrue.elements[1]) ||
      !ts.isArrayLiteralExpression(conditional.whenFalse) ||
      conditional.whenFalse.elements.length
    )
      unsupported(defaultsFile, 'unrecognized spread in baseLsArgs');
  }
  for (const [flag, constant] of [
    ['--api_server_url', 'LS_API_SERVER_URL'],
    ['--cloud_code_endpoint', 'LS_CLOUD_CODE_ENDPOINT'],
  ]) {
    const entry = one(
      defaultsFile,
      matching(helper, (node) => ts.isStringLiteral(node) && node.text === flag),
      flag,
    );
    const value = elements[elements.indexOf(entry) + 1];
    if (
      !elements.includes(entry) ||
      !value ||
      !ts.isPropertyAccessExpression(value) ||
      !ts.isIdentifier(value.expression) ||
      value.expression.text !== 'exports' ||
      value.name.text !== constant
    )
      unsupported(defaultsFile, `${flag} must use its exported vendor endpoint`);
    const assignment = one(
      defaultsFile,
      assignments(constant).filter((node) => ts.isStringLiteral(node.right)),
      `${constant} literal assignment`,
    );
    if (
      !assignment.right.text.startsWith('https://') ||
      !ts.isExpressionStatement(assignment.parent) ||
      assignment.parent.parent !== tree
    )
      unsupported(defaultsFile, `${constant} must have a top-level literal HTTPS vendor endpoint`);
    for (const write of assignments(constant).filter((node) => node !== assignment)) {
      // TypeScript also emits a chained exports initialization to void 0.
      let value = write.right;
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        value = value.right;
      if (
        !ts.isVoidExpression(value) ||
        !ts.isNumericLiteral(value.expression) ||
        value.expression.text !== '0' ||
        write.getStart(tree) > assignment.getStart(tree)
      )
        unsupported(defaultsFile, `${constant} has an unrecognized reassignment`);
    }
  }
  if (matching(helper, (node) => ts.isStringLiteral(node) && node.text === '--inference_api_server_url').length)
    unsupported(defaultsFile, 'inference endpoint in baseLsArgs is not a recognized layout');
}

function patchLanguageServer(bytes, readVendorFile) {
  const file = 'dist/languageServer.js';
  const { source, tree } = parse(file, bytes);
  const fn = one(
    file,
    matching(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'startLanguageServer'),
    'startLanguageServer function',
  );
  if (
    fn.parent !== tree ||
    !fn.body ||
    fn.asteriskToken ||
    fn.parameters.length !== 3 ||
    fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name))
  ) {
    unsupported(file, 'unrecognized startLanguageServer signature');
  }
  const options = fn.parameters[2];
  const hasOptions =
    options.name.text === 'options' &&
    options.initializer &&
    ts.isObjectLiteralExpression(options.initializer) &&
    options.initializer.properties.length === 0;
  const legacyHeadless = options.name.text === 'headless' && !options.initializer;
  if (!hasOptions && !legacyHeadless) unsupported(file, 'expected options = {} or legacy headless parameter');
  if (matching(tree, (node) => ts.isIdentifier(node) && node.text === LOCAL_URL).length) {
    unsupported(file, `reserved identifier ${LOCAL_URL} already exists`);
  }
  const args = one(
    file,
    matching(
      fn.body,
      (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'args',
    ),
    'language-server args declaration',
  );
  if (
    !args.initializer ||
    !ts.isArrayLiteralExpression(args.initializer) ||
    !ts.isVariableDeclarationList(args.parent) ||
    !ts.isVariableStatement(args.parent.parent)
  ) {
    unsupported(file, 'language-server args must be a literal array in a variable statement');
  }
  const returned = one(file, fn.body.statements.filter(ts.isReturnStatement), 'returned startup Promise');
  const promise = returned.expression;
  const executor = promise && ts.isNewExpression(promise) && promise.arguments?.[0];
  if (
    !promise ||
    !ts.isNewExpression(promise) ||
    !ts.isIdentifier(promise.expression) ||
    promise.expression.text !== 'Promise' ||
    promise.arguments?.length !== 1 ||
    !executor ||
    !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) ||
    args.parent.parent.parent !== executor.body
  ) {
    unsupported(file, 'args must be declared directly in the returned startup Promise');
  }
  const elements = args.initializer.elements;
  const spreads = elements.filter(ts.isSpreadElement);
  if (spreads.length) {
    if (spreads.length !== 1 || elements[0] !== spreads[0] || !hasOptions)
      unsupported(file, 'spread arguments are not a recognized startup layout');
    validateSharedLsArgs(readVendorFile, tree, spreads[0]);
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      if (matching(fn.body, (node) => ts.isStringLiteral(node) && node.text === flag).length)
        unsupported(file, `${flag} must not override the shared base args`);
    }
  }
  const edits = [];
  for (const flag of spreads.length ? [] : ['--api_server_url', '--cloud_code_endpoint']) {
    const entry = one(
      file,
      matching(fn.body, (node) => ts.isStringLiteral(node) && node.text === flag),
      flag,
    );
    if (!elements.includes(entry)) unsupported(file, `${flag} must occur in the startup args array`);
    const value = elements[elements.indexOf(entry) + 1];
    if (!value || !ts.isStringLiteral(value) || !value.text.startsWith('https://')) {
      unsupported(file, `${flag} must have a literal HTTPS vendor endpoint`);
    }
    edits.push({ start: value.getStart(tree), end: value.end, text: `(${LOCAL_URL} || ${value.getText(tree)})` });
  }
  const inference = matching(fn.body, (node) => ts.isStringLiteral(node) && node.text === '--inference_api_server_url');
  if (inference.length) {
    const entry = one(file, inference, '--inference_api_server_url');
    if (!elements.includes(entry)) unsupported(file, '--inference_api_server_url must occur in the startup args array');
    const value = elements[elements.indexOf(entry) + 1];
    if (!value || !ts.isStringLiteral(value) || !value.text.startsWith('https://')) {
      unsupported(file, '--inference_api_server_url must have a literal HTTPS vendor endpoint');
    }
    edits.push({ start: value.getStart(tree), end: value.end, text: `(${LOCAL_URL} || ${value.getText(tree)})` });
  } else {
    edits.push({
      start: args.parent.parent.end,
      text: spreads.length
        ? `\n        if (${LOCAL_URL}) {\n` +
          `            for (const flag of ['--api_server_url', '--cloud_code_endpoint']) {\n` +
          `                args[args.indexOf(flag) + 1] = ${LOCAL_URL};\n` +
          `            }\n` +
          `            args.push('--inference_api_server_url', ${LOCAL_URL});\n        }`
        : `\n        if (${LOCAL_URL}) args.push('--inference_api_server_url', ${LOCAL_URL});`,
    });
  }
  if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    edits.push({ start: fn.getStart(tree), text: 'async ' });
  }
  edits.push({
    start: fn.body.getStart(tree) + 1,
    text:
      `\n    ${MARKER}\n    const ${LOCAL_URL} = ${hasOptions ? 'options.wsl ? undefined : ' : ''}` +
      `'http://localhost:' + await require('./modelPatch/proxy').startProxy();\n`,
  });
  return applyEdits(file, source, edits);
}

function patchPreload(vendorBytes, augmentations) {
  const file = 'dist/preload.js';
  const { source } = parse(file, vendorBytes);
  const additions = augmentations.map(({ name, bytes }) => {
    const custom = parse(name, bytes);
    for (const node of matching(custom.tree, (node) => ts.isCallExpression(node))) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== 'electron')
      ) {
        unsupported(name, 'sandboxed custom preload may only require electron');
      }
      if (
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'exposeInMainWorld') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        unsupported(name, 'custom preload must not redeclare vendor bridges or import other modules');
      }
    }
    return `\n(() => {\nconst exports = {};\n${custom.source}\n})();\n`;
  });
  return applyEdits(file, source, [
    {
      start: source.length,
      text: `\n;${MARKER}\n${additions.join('')}`,
    },
  ]);
}

/**
 * Return only the three modified vendor files. Callbacks synchronously return
 * Buffer/string contents. Vendor paths are archive-relative; build paths are
 * relative to dist. The caller separately copies its build into dist/modelPatch.
 */
export function planRuntimePatch(readVendorFile, readBuildFile, userDataDir) {
  return new Map([
    ['dist/main.js', patchMain(readInput(readVendorFile, 'dist/main.js'), userDataDir)],
    [
      'dist/languageServer.js',
      patchLanguageServer(readInput(readVendorFile, 'dist/languageServer.js'), readVendorFile),
    ],
    [
      'dist/preload.js',
      patchPreload(
        readInput(readVendorFile, 'dist/preload.js'),
        ['customPreload.js', 'contextUsagePreload.js'].map((name) => ({ name, bytes: readInput(readBuildFile, name) })),
      ),
    ],
  ]);
}
