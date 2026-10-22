// Owns portable worker emission; remote Node receives JavaScript without local TS loaders.
// Never serialize a transpiled function.toString(): loaders can inject free helpers.
import { readFileSync } from 'node:fs';

import ts from 'typescript';

function workerSource(name: string) {
  const path = new URL(name, import.meta.url);
  const source = ts.createSourceFile(
    name,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const result = ts.transform(source, [
    (context) => (file) =>
      ts.visitEachChild(
        file,
        (node) => (ts.isImportDeclaration(node) ? undefined : node),
        context,
      ),
  ]);
  try {
    const text = ts.createPrinter().printFile(result.transformed[0]!);
    return ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
  } finally {
    result.dispose();
  }
}

export function nativeSource(role: string) {
  const worker =
    role === 'seller'
      ? 'nativeSeller'
      : role === 'observer'
        ? 'nativeObserver'
        : 'nativeBuyer';
  return `${workerSource('lab-reflection.ts')}\n${workerSource('iroh-workers.ts')}\nawait ${worker}();`;
}
