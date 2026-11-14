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

function isProperty(node, object, name) {
  return (
    node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === name &&
    (!object || (ts.isIdentifier(node.expression) && node.expression.text === object))
  );
}

function callTarget(expression) {
  if (!ts.isParenthesizedExpression(expression)) return expression;
  const comma = expression.expression;
  if (
    !ts.isBinaryExpression(comma) ||
    comma.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    !ts.isNumericLiteral(comma.left) ||
    comma.left.text !== '0'
  ) {
    return null;
  }
  return comma.right;
}

function isNamedCall(node, receiver, name) {
  if (!ts.isCallExpression(node)) return false;
  return isProperty(callTarget(node.expression), receiver, name);
}

function inTopLevelExpression(tree, node) {
  let current = node.parent;
  while (ts.isBinaryExpression(current)) current = current.parent;
  return ts.isExpressionStatement(current) && current.parent === tree;
}

function validateRequireBinding(tree, binding, moduleName) {
  const file = 'dist/languageServer.js';
  const imported = one(
    file,
    matching(
      tree,
      (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === binding,
    ),
    `${moduleName} import binding`,
  );
  const requireCall = imported.initializer;
  if (
    imported.parent.parent.parent !== tree ||
    !(imported.parent.flags & ts.NodeFlags.Const) ||
    !requireCall ||
    !ts.isCallExpression(requireCall) ||
    !ts.isIdentifier(requireCall.expression) ||
    requireCall.expression.text !== 'require' ||
    requireCall.arguments.length !== 1 ||
    !ts.isStringLiteral(requireCall.arguments[0]) ||
    requireCall.arguments[0].text !== moduleName
  ) {
    unsupported(file, `${binding} must be a top-level const require(${JSON.stringify(moduleName)}) binding`);
  }
}

function validateBaseLsDefaults(bytes) {
  const file = 'dist/lsDefaults.js';
  const { tree } = parse(file, bytes);
  const helper = one(
    file,
    matching(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'baseLsArgs'),
    'baseLsArgs function',
  );
  if (
    helper.parent !== tree ||
    !helper.body ||
    helper.body.statements.length !== 1 ||
    helper.modifiers?.length ||
    helper.asteriskToken ||
    helper.parameters.length !== 1 ||
    !ts.isIdentifier(helper.parameters[0].name) ||
    helper.parameters[0].dotDotDotToken ||
    helper.parameters[0].questionToken ||
    helper.parameters[0].initializer
  ) {
    unsupported(file, 'unrecognized baseLsArgs signature');
  }
  const parameter = helper.parameters[0].name.text;
  const returned = helper.body.statements[0];
  if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isArrayLiteralExpression(returned.expression)) {
    unsupported(file, 'baseLsArgs must directly return one literal array');
  }
  const elements = returned.expression.elements;
  if (elements.length !== 19 || elements.some(ts.isSpreadElement)) {
    unsupported(file, 'baseLsArgs must contain the recognized 19 literal entries');
  }
  const literals = new Map([
    [0, '--standalone'],
    [1, '--override_ide_name'],
    [2, 'antigravity'],
    [3, '--subclient_type'],
    [4, 'hub'],
    [5, '--override_ide_version'],
    [7, '--override_user_agent_name'],
    [8, 'antigravity'],
    [9, '--https_server_port'],
    [11, '--csrf_token'],
    [13, '--app_data_dir'],
    [15, '--api_server_url'],
    [17, '--cloud_code_endpoint'],
  ]);
  for (const [index, text] of literals) {
    if (!ts.isStringLiteral(elements[index]) || elements[index].text !== text) {
      unsupported(file, `unexpected baseLsArgs entry at index ${index}`);
    }
  }
  const isOption = (node, name) => isProperty(node, parameter, name);
  if (
    !isOption(elements[6], 'ideVersion') ||
    !isOption(elements[12], 'csrfToken') ||
    !isOption(elements[14], 'appDataDir') ||
    !isProperty(elements[16], 'exports', 'LS_API_SERVER_URL') ||
    !isProperty(elements[18], 'exports', 'LS_CLOUD_CODE_ENDPOINT')
  ) {
    unsupported(file, 'baseLsArgs option or endpoint forwarding changed');
  }
  const port = elements[10];
  if (
    !ts.isCallExpression(port) ||
    !ts.isIdentifier(port.expression) ||
    port.expression.text !== 'String' ||
    port.arguments.length !== 1 ||
    !isOption(port.arguments[0], 'httpsServerPort')
  ) {
    unsupported(file, 'baseLsArgs HTTPS port forwarding changed');
  }
  const exportNames = new Set(['baseLsArgs', 'LS_API_SERVER_URL', 'LS_CLOUD_CODE_ENDPOINT']);
  const allowedExportReferences = new Set([elements[16], elements[18]]);
  const allowedTopLevelExpressions = new Set();
  for (const [name, value] of [
    ['LS_API_SERVER_URL', 'https://generativelanguage.googleapis.com'],
    ['LS_CLOUD_CODE_ENDPOINT', 'https://daily-cloudcode-pa.googleapis.com'],
  ]) {
    const writes = matching(tree, (node) => ts.isBinaryExpression(node) && isProperty(node.left, 'exports', name));
    const assignment = one(
      file,
      writes.filter(
        (node) =>
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isStringLiteral(node.right) &&
          inTopLevelExpression(tree, node),
      ),
      `${name} top-level literal assignment`,
    );
    const initialization = one(
      file,
      writes.filter(
        (node) =>
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (name === 'LS_CLOUD_CODE_ENDPOINT'
            ? ts.isBinaryExpression(node.right) &&
              node.right.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              isProperty(node.right.left, 'exports', 'LS_API_SERVER_URL') &&
              ts.isVoidExpression(node.right.right)
            : ts.isVoidExpression(node.right)) &&
          inTopLevelExpression(tree, node),
      ),
      `${name} top-level void initialization`,
    );
    if (writes.length !== 2) unsupported(file, `${name} has unrecognized or repeated writes`);
    if (assignment.right.text !== value) unsupported(file, `${name} no longer has its vendor value`);
    allowedExportReferences.add(assignment.left).add(initialization.left);
    allowedTopLevelExpressions.add(assignment).add(initialization);
  }
  const helperExport = one(
    file,
    matching(
      tree,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProperty(node.left, 'exports', 'baseLsArgs') &&
        ts.isIdentifier(node.right) &&
        node.right.text === 'baseLsArgs' &&
        inTopLevelExpression(tree, node),
    ),
    'top-level baseLsArgs export',
  );
  allowedExportReferences.add(helperExport.left);
  const esModule = one(
    file,
    matching(tree, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !isProperty(node.expression, 'Object', 'defineProperty') ||
        node.arguments.length !== 3 ||
        !ts.isIdentifier(node.arguments[0]) ||
        node.arguments[0].text !== 'exports' ||
        !ts.isStringLiteral(node.arguments[1]) ||
        node.arguments[1].text !== '__esModule' ||
        !ts.isObjectLiteralExpression(node.arguments[2]) ||
        node.arguments[2].properties.length !== 1
      ) {
        return false;
      }
      const descriptor = node.arguments[2].properties[0];
      return (
        ts.isPropertyAssignment(descriptor) &&
        ts.isIdentifier(descriptor.name) &&
        descriptor.name.text === 'value' &&
        descriptor.initializer.kind === ts.SyntaxKind.TrueKeyword &&
        inTopLevelExpression(tree, node)
      );
    }),
    'top-level __esModule definition',
  );
  allowedTopLevelExpressions.add(helperExport).add(esModule);
  for (const statement of tree.statements) {
    if (statement === helper) continue;
    if (ts.isExpressionStatement(statement)) {
      if (allowedTopLevelExpressions.has(statement.expression)) continue;
      if (ts.isStringLiteral(statement.expression) && statement.expression.text === 'use strict') continue;
    }
    unsupported(file, 'unrecognized top-level statement in shared defaults');
  }
  for (const reference of matching(
    tree,
    (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'exports' &&
      exportNames.has(node.name.text),
  )) {
    if (!allowedExportReferences.has(reference))
      unsupported(file, `unrecognized exports.${reference.name.text} access`);
  }
  if (matching(tree, (node) => ts.isStringLiteralLike(node) && node.text === '--inference_api_server_url').length) {
    unsupported(file, 'the recognized shared defaults must not contain an inference endpoint');
  }
}

function validateSpreadStartup(tree, fn, args) {
  const file = 'dist/languageServer.js';
  const optionsDeclaration = one(
    file,
    matching(
      fn.body,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === 'options',
    ),
    'top-level options destructuring',
  );
  if (optionsDeclaration.parent.parent.parent !== fn.body || !(optionsDeclaration.parent.flags & ts.NodeFlags.Const)) {
    unsupported(file, 'options must be destructured into top-level const bindings in startLanguageServer');
  }
  const bindingNames = ['headless', 'hostBridgeUrl', 'hostBridgeToken', 'wsl'];
  const bindings = optionsDeclaration.name.elements;
  if (bindings.length !== bindingNames.length) unsupported(file, 'unrecognized options destructuring');
  bindings.forEach((binding, index) => {
    if (
      !ts.isIdentifier(binding.name) ||
      binding.name.text !== bindingNames[index] ||
      binding.propertyName ||
      binding.dotDotDotToken ||
      binding.initializer
    ) {
      unsupported(file, `unrecognized options binding at index ${index}`);
    }
  });
  const elements = args.initializer.elements;
  if (
    elements.length !== 2 ||
    !ts.isSpreadElement(elements[0]) ||
    !ts.isStringLiteral(elements[1]) ||
    elements[1].text !== '--enable_sidecars'
  ) {
    unsupported(file, 'expected exactly one shared-defaults spread followed by --enable_sidecars');
  }
  const call = elements[0].expression;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) {
    unsupported(file, 'shared defaults must be one baseLsArgs call');
  }
  const target = callTarget(call.expression);
  if (!isProperty(target, undefined, 'baseLsArgs') || !ts.isIdentifier(target.expression)) {
    unsupported(file, 'shared defaults must call an imported baseLsArgs binding');
  }
  const importName = target.expression.text;
  validateRequireBinding(tree, importName, './lsDefaults');
  for (const [binding, moduleName] of [
    ['electron_1', 'electron'],
    ['paths_1', './paths'],
    ['wsl_1', './wsl'],
    ['child_process_1', 'child_process'],
  ]) {
    validateRequireBinding(tree, binding, moduleName);
  }
  const options = call.arguments[0];
  const names = ['ideVersion', 'httpsServerPort', 'csrfToken', 'appDataDir'];
  if (!ts.isObjectLiteralExpression(options) || options.properties.length !== names.length) {
    unsupported(file, 'baseLsArgs must receive the four recognized options');
  }
  options.properties.forEach((property, index) => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== names[index]) {
      unsupported(file, `unrecognized baseLsArgs option at index ${index}`);
    }
  });
  const values = options.properties.map((property) => property.initializer);
  const versionTarget = ts.isCallExpression(values[0]) ? callTarget(values[0].expression) : null;
  if (
    !ts.isCallExpression(values[0]) ||
    values[0].arguments.length ||
    !isProperty(versionTarget, undefined, 'getVersion') ||
    !isProperty(versionTarget.expression, 'electron_1', 'app') ||
    !ts.isIdentifier(values[1]) ||
    values[1].text !== fn.parameters[0].name.text ||
    !ts.isIdentifier(values[2]) ||
    values[2].text !== fn.parameters[1].name.text ||
    !isNamedCall(values[3], 'paths_1', 'getAppDataDirName') ||
    values[3].arguments.length
  ) {
    unsupported(file, 'baseLsArgs option values changed');
  }

  const endpointFlags = new Set(['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']);
  if (matching(fn.body, (node) => ts.isStringLiteralLike(node) && endpointFlags.has(node.text)).length) {
    unsupported(file, 'shared-defaults startup must not override endpoint flags locally');
  }
  const pushes = matching(
    fn.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'args' &&
      node.expression.name.text === 'push',
  );
  if (pushes.length !== 3) unsupported(file, 'expected exactly three recognized args.push calls');
  const receivers = new Set();
  const pushesByKind = new Map();
  const isTemplate = (node, head, name) =>
    ts.isTemplateExpression(node) &&
    node.head.text === head &&
    node.templateSpans.length === 1 &&
    ts.isIdentifier(node.templateSpans[0].expression) &&
    node.templateSpans[0].expression.text === name;
  for (const push of pushes) {
    let kind;
    if (
      push.arguments.length === 2 &&
      isTemplate(push.arguments[0], '--host_bridge_url=', 'hostBridgeUrl') &&
      isTemplate(push.arguments[1], '--host_bridge_token=', 'hostBridgeToken')
    ) {
      kind = 'host-bridge';
    } else if (
      push.arguments.length === 1 &&
      ts.isStringLiteral(push.arguments[0]) &&
      ['--headless', '--exit_on_stdin_close'].includes(push.arguments[0].text)
    ) {
      kind = push.arguments[0].text;
    } else {
      unsupported(file, 'unrecognized mutation of shared-defaults args');
    }
    if (pushesByKind.has(kind)) unsupported(file, `duplicate ${kind} args.push call`);
    pushesByKind.set(kind, push);
    receivers.add(push.expression.expression);
  }

  let spawnArgsDeclaration;
  let wslCall;
  for (const reference of matching(fn.body, (node) => ts.isIdentifier(node) && node.text === 'args')) {
    if (reference === args.name || receivers.has(reference)) continue;
    const parent = reference.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === reference &&
      ts.isIdentifier(parent.name) &&
      parent.name.text === 'spawnArgs'
    ) {
      if (spawnArgsDeclaration) unsupported(file, 'multiple spawnArgs aliases');
      spawnArgsDeclaration = parent;
    } else if (
      ts.isCallExpression(parent) &&
      parent.arguments.length === 3 &&
      parent.arguments[2] === reference &&
      isNamedCall(parent, 'wsl_1', 'wslShellArgs')
    ) {
      if (wslCall) unsupported(file, 'multiple WSL argument wrappers');
      wslCall = parent;
    } else {
      unsupported(file, 'unrecognized alias or mutation of shared-defaults args');
    }
  }
  if (!spawnArgsDeclaration || !wslCall) unsupported(file, 'missing recognized spawnArgs or WSL wrapper');
  let spawnCall;
  let wslAssignment = 0;
  for (const reference of matching(fn.body, (node) => ts.isIdentifier(node) && node.text === 'spawnArgs')) {
    if (reference === spawnArgsDeclaration.name) continue;
    const parent = reference.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === reference &&
      parent.right === wslCall
    ) {
      wslAssignment++;
    } else if (
      ts.isCallExpression(parent) &&
      parent.arguments.length === 3 &&
      parent.arguments[1] === reference &&
      isNamedCall(parent, 'child_process_1', 'spawn')
    ) {
      if (spawnCall) unsupported(file, 'multiple language-server spawn calls');
      spawnCall = parent;
    } else {
      unsupported(file, 'unrecognized mutation of language-server spawnArgs');
    }
  }
  if (wslAssignment !== 1 || !spawnCall) unsupported(file, 'unrecognized local or WSL spawn argument flow');
  const assignmentStatement = wslCall.parent.parent;
  if (
    !ts.isExpressionStatement(assignmentStatement) ||
    !ts.isBlock(assignmentStatement.parent) ||
    !ts.isIfStatement(assignmentStatement.parent.parent)
  ) {
    unsupported(file, 'WSL argument wrapping must use the recognized guarded statement');
  }
  const wslBlock = assignmentStatement.parent;
  const wslIf = wslBlock.parent;
  if (wslIf.thenStatement !== wslBlock || !ts.isIdentifier(wslIf.expression) || wslIf.expression.text !== 'wsl') {
    unsupported(file, 'WSL argument wrapping must be guarded by the validated wsl binding');
  }
  const exitPush = pushesByKind.get('--exit_on_stdin_close');
  if (!exitPush || !ts.isExpressionStatement(exitPush.parent) || exitPush.parent.parent !== wslBlock) {
    unsupported(file, '--exit_on_stdin_close must be added only in the validated WSL branch');
  }
  return optionsDeclaration;
}

function patchSpreadLanguageServer({ source, tree, fn, args, hasOptions }, readDefaults) {
  const file = 'dist/languageServer.js';
  if (!hasOptions) unsupported(file, 'shared-defaults startup requires the options = {} signature');
  const optionsDeclaration = validateSpreadStartup(tree, fn, args);
  validateBaseLsDefaults(readDefaults());
  const edits = [];
  if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    edits.push({ start: fn.getStart(tree), text: 'async ' });
  }
  edits.push(
    {
      start: optionsDeclaration.parent.parent.end,
      text:
        `\n    ${MARKER}\n    const ${LOCAL_URL} = wsl ? undefined : ` +
        `'http://localhost:' + await require('./modelPatch/proxy').startProxy();\n`,
    },
    {
      start: args.parent.parent.end,
      text: `
        if (${LOCAL_URL}) {
          for (const flag of ['--api_server_url', '--cloud_code_endpoint']) {
            const index = args.indexOf(flag);
            if (index < 0 || index !== args.lastIndexOf(flag) || index + 1 >= args.length) {
              throw new Error('Unexpected language-server endpoint arguments: ' + flag);
            }
            args[index + 1] = ${LOCAL_URL};
          }
          if (args.includes('--inference_api_server_url')) {
            throw new Error('Unexpected duplicate language-server inference endpoint');
          }
          args.push('--inference_api_server_url', ${LOCAL_URL});
        }`,
    },
  );
  return applyEdits(file, source, edits);
}

function patchLanguageServer(bytes, readDefaults) {
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
  if (elements.some(ts.isSpreadElement)) {
    return patchSpreadLanguageServer({ source, tree, fn, args, hasOptions }, readDefaults);
  }
  const edits = [];
  for (const flag of ['--api_server_url', '--cloud_code_endpoint']) {
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
      text: `\n        if (${LOCAL_URL}) args.push('--inference_api_server_url', ${LOCAL_URL});`,
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
      patchLanguageServer(readInput(readVendorFile, 'dist/languageServer.js'), () =>
        readInput(readVendorFile, 'dist/lsDefaults.js'),
      ),
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
