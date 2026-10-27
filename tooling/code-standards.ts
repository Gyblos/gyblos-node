// Owns static naming/import/version checks; it must not start applications.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

type Identifier = { type: 'Identifier'; name: string };
type BindingPattern =
  | Identifier
  | { type: 'RestElement'; argument: BindingPattern }
  | { type: 'AssignmentPattern'; left: BindingPattern }
  | { type: 'ArrayPattern'; elements: (BindingPattern | null)[] }
  | {
      type: 'ObjectPattern';
      properties: (
        | { type: 'RestElement'; argument: BindingPattern }
        | { type: 'Property'; value: BindingPattern }
      )[];
    }
  | null;
type SourceNode = {
  source: {
    type: string;
    value?: unknown;
    expressions?: unknown[];
    quasis?: { value: { cooked: string | null } }[];
  } | null;
};
type RuleContext = {
  filename: string;
  report: (report: {
    node: object;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
};

const SHORT_BINDINGS = new Set([
  'c',
  'sig',
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
  'v',
  'e',
  'env',
  'jwk',
  'addr',
]);

function packageRoot(filename: string) {
  const parts = filename.split('/');
  const index = parts.findIndex((part) =>
    ['apps', 'packages', 'lab'].includes(part),
  );
  return index < 0 ? null : parts.slice(0, index + 2).join('/');
}

function bindingNames(pattern: BindingPattern): Identifier[] {
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
      binding: 'Use a descriptive binding instead of "{{name}}".',
    },
  },
  create(context: RuleContext) {
    function checkBinding(pattern: BindingPattern) {
      for (const identifier of bindingNames(pattern)) {
        if (SHORT_BINDINGS.has(identifier.name.replace(/^_+/, '')))
          context.report({
            node: identifier,
            messageId: 'binding',
            data: { name: identifier.name },
          });
      }
    }
    return {
      VariableDeclarator(node: { id: BindingPattern }) {
        checkBinding(node.id);
      },
      FunctionDeclaration(node: { params: BindingPattern[] }) {
        node.params.forEach(checkBinding);
      },
      FunctionExpression(node: { params: BindingPattern[] }) {
        node.params.forEach(checkBinding);
      },
      ArrowFunctionExpression(node: { params: BindingPattern[] }) {
        node.params.forEach(checkBinding);
      },
      CatchClause(node: { param: BindingPattern }) {
        checkBinding(node.param);
      },
    };
  },
};

const packageBoundaries = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      boundary:
        'Import other packages by workspace name; relative imports stay inside their package.',
    },
  },
  create(context: RuleContext) {
    const filename = context.filename.replaceAll('\\', '/');
    const root = packageRoot(filename);
    function checkSource(node: SourceNode) {
      const source = sourceText(node.source);
      if (typeof source !== 'string') return;
      if (!source) return;
      if (root && source.startsWith('.')) {
        const target = resolve(dirname(filename), source);
        if (relative(root, target).startsWith('..'))
          context.report({ node, messageId: 'boundary' });
      }
    }
    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
    };
  },
};

// Relative modules resolve without an extension (Bundler resolution); assets such as JSON or CSS keep theirs.
const CODE_EXTENSION = /\.[cm]?[jt]sx?$/;

function sourceText(literal: SourceNode['source']) {
  return literal?.type === 'TemplateLiteral' &&
    literal.expressions?.length === 0
    ? literal.quasis?.[0]?.value.cooked
    : literal?.value;
}

const importExtensions = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      extension: 'Import relative TypeScript modules without an extension.',
    },
  },
  create(context: RuleContext) {
    function checkSource(node: SourceNode) {
      const source = sourceText(node.source);
      if (
        typeof source === 'string' &&
        source.startsWith('.') &&
        CODE_EXTENSION.test(source)
      )
        context.report({ node, messageId: 'extension' });
    }
    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
      // `import('./x').T` in type positions; `source` replaces the deprecated `argument`.
      TSImportType: checkSource,
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
  create(context: RuleContext) {
    return {
      Program(node: object) {
        const root = resolve(dirname(context.filename), '../../..');
        const manifest = (path: string): Record<string, string> =>
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
    'package-boundaries': packageBoundaries,
    'import-extensions': importExtensions,
    'version-pins': versionPins,
  },
};
