import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const SHORT_BINDINGS = new Set([
  'c',
  'sig',
  'tx',
  'req',
  'res',
  'r',
  'm',
  'ix',
  'f',
  'fs',
  'fa',
  's',
  'ss',
  'sa',
  'b',
  'a',
  'k',
  'i',
  'v',
  'e',
  'env',
  'jwk',
  'addr',
]);
const SIMPLE_NUMBERS = new Set([0, 1, 2, 0n, 1n, 2n]);

function declarationRank(node) {
  if (node.type === 'ImportDeclaration') return 0;
  const declaration = node.declaration ?? node;
  if (
    ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(
      declaration.type,
    )
  )
    return 2;
  if (node.exportKind === 'type') return 2;
  if (declaration.type === 'VariableDeclaration') {
    const functions = declaration.declarations.every(({ init }) =>
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(init?.type),
    );
    return functions ? (node === declaration ? 3 : 4) : 1;
  }
  if (
    declaration.type === 'FunctionDeclaration' &&
    declaration.id?.name === 'main'
  )
    return 5;
  if (node.type.startsWith('Export')) return 4;
  if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type)) return 3;
  return 6;
}

function packageRoot(filename) {
  const parts = filename.split('/');
  const index = parts.findIndex((part) => ['apps', 'packages'].includes(part));
  return index < 0 ? null : parts.slice(0, index + 2).join('/');
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern];
  if (pattern.type === 'RestElement') return bindingNames(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left);
  if (pattern.type === 'ArrayPattern')
    return pattern.elements.flatMap(bindingNames);
  if (pattern.type === 'ObjectPattern')
    return pattern.properties.flatMap((property) =>
      bindingNames(
        property.type === 'RestElement' ? property.argument : property.value,
      ),
    );
  return [];
}

const structure = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      order:
        'Follow imports, constants, types, private helpers, exports, main, invocation order.',
      constant: 'Name file-local data constants in UPPER_SNAKE_CASE.',
      binding: 'Use a descriptive binding instead of "{{name}}".',
      boundary:
        'Import other packages by workspace name; relative imports stay inside their package.',
      scripts: 'Application and package code must not import scripts.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const root = packageRoot(filename);
    function checkBinding(pattern) {
      for (const identifier of bindingNames(pattern)) {
        if (SHORT_BINDINGS.has(identifier.name.replace(/^_+/, '')))
          context.report({
            node: identifier,
            messageId: 'binding',
            data: { name: identifier.name },
          });
      }
    }
    function checkSource(node) {
      const source = node.source?.value;
      if (!source) return;
      if (root && /(^|\/)scripts\//.test(source))
        context.report({ node, messageId: 'scripts' });
      if (root && source.startsWith('.')) {
        const target = resolve(dirname(filename), source);
        if (relative(root, target).startsWith('..'))
          context.report({ node, messageId: 'boundary' });
      }
    }
    return {
      Program(program) {
        let previous = 0;
        for (const statement of program.body) {
          const rank = declarationRank(statement);
          if (rank < previous)
            context.report({ node: statement, messageId: 'order' });
          previous = Math.max(previous, rank);
          if (statement.type === 'VariableDeclaration' && rank === 1) {
            for (const declaration of statement.declarations) {
              for (const identifier of bindingNames(declaration.id)) {
                if (!/^[A-Z][A-Z0-9_]*$/.test(identifier.name))
                  context.report({ node: identifier, messageId: 'constant' });
              }
            }
          }
        }
      },
      VariableDeclarator(node) {
        checkBinding(node.id);
      },
      FunctionDeclaration(node) {
        node.params.forEach(checkBinding);
      },
      FunctionExpression(node) {
        node.params.forEach(checkBinding);
      },
      ArrowFunctionExpression(node) {
        node.params.forEach(checkBinding);
      },
      CatchClause(node) {
        checkBinding(node.param);
      },
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
    };
  },
};

const numericConstants = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      numeric:
        'Move this operational value into @gyblos/config or its package constants.ts.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'number' && typeof node.value !== 'bigint')
          return;
        if (!SIMPLE_NUMBERS.has(node.value))
          context.report({ node, messageId: 'numeric' });
      },
    };
  },
};

const versionPins = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      mismatch:
        'Config version metadata must match the dependency pin for {{dependency}}.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const root = resolve(dirname(context.filename), '../../..');
        const manifest = (path) =>
          JSON.parse(readFileSync(resolve(root, path), 'utf8')).dependencies;
        const metadata = manifest('packages/config/package.json');
        const paths = [
          'package.json',
          ...['apps', 'packages', 'lab']
            .flatMap((directory) =>
              !existsSync(resolve(root, directory))
                ? []
                : readdirSync(resolve(root, directory), { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => `${directory}/${entry.name}/package.json`),
            )
            .filter((path) => existsSync(resolve(root, path))),
        ];
        const manifests = paths.map(manifest);
        for (const dependency of Object.keys(metadata)) {
          if (
            manifests.some(
              (dependencies) =>
                dependencies?.[dependency] !== undefined &&
                dependencies[dependency] !== metadata[dependency],
            )
          )
            context.report({
              node,
              messageId: 'mismatch',
              data: { dependency },
            });
        }
      },
    };
  },
};

export default {
  rules: {
    structure,
    'numeric-constants': numericConstants,
    'version-pins': versionPins,
  },
};
