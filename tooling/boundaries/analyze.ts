// Owns static graph analysis and deterministic, validated violation entries.
// Product modules are parsed, never executed; runtime data must not enter reports.
import { isAbsolute, relative } from 'node:path';

import { cruise } from 'dependency-cruiser';

import { boundaryConfig, layerOf, PRIVATE_PATH } from './config';
import { isRecord, parseGraph } from './graph';
import { isSafeSource } from './inventory';

export interface BoundaryEntry {
  rule: string;
  source: string;
  target: string;
}

export interface BoundaryAnalysis {
  entries: BoundaryEntry[];
  modules: number;
}

function normalizePath(source: string, root: string): string {
  const normalized = (
    isAbsolute(source) ? relative(root, source) : source
  ).replaceAll('\\', '/');
  if (normalized.startsWith('../') || isAbsolute(normalized))
    throw new Error('Analysis encountered a path outside the repository.');
  return normalized;
}

export function entryKey(entry: BoundaryEntry): string {
  return JSON.stringify([entry.rule, entry.source, entry.target]);
}

export function validateEntries(value: unknown): BoundaryEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid boundary entries.');
  const validated: BoundaryEntry[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.rule !== 'string' ||
      typeof entry.source !== 'string' ||
      typeof entry.target !== 'string' ||
      Object.keys(entry).sort().join(',') !== 'rule,source,target' ||
      ![entry.rule, entry.source, entry.target].every(
        (part) =>
          typeof part === 'string' &&
          part.length > 0 &&
          !/[\r\n\0\\]/.test(part),
      ) ||
      !/^[a-z][a-z0-9-]*$/.test(entry.rule) ||
      [entry.source, entry.target].some(
        (part) =>
          isAbsolute(part) ||
          part.split('/').includes('..') ||
          new RegExp(PRIVATE_PATH).test(part),
      )
    )
      throw new Error('Invalid boundary entry.');
    validated.push({
      rule: entry.rule,
      source: entry.source,
      target: entry.target,
    });
  }
  if (new Set(validated.map(entryKey)).size !== validated.length)
    throw new Error('Duplicate boundary entries.');
  return validated;
}

export async function analyze(
  files: string[],
  root: string,
): Promise<BoundaryAnalysis> {
  if (files.length === 0)
    throw new Error('No source files found for boundary analysis.');
  const packageNames = [
    ...new Set(
      files
        .map((file) => file.match(/^packages\/([^/]+)\//)?.[1])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  const appNames = [
    ...new Set(
      files
        .map((file) => file.match(/^apps\/([^/]+)\//)?.[1])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (files.some((file) => !layerOf(file)))
    throw new Error(
      'Unmapped source package; update the architectural layer map.',
    );
  if (
    (await Promise.all(files.map((file) => isSafeSource(root, file)))).some(
      (safe) => !safe,
    )
  )
    throw new Error('Unsafe source path in boundary inventory.');
  const config = boundaryConfig(packageNames, appNames);
  const allowedPaths = files
    .map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const result = await cruise(files, {
    ...config.options,
    // Retain unknown dependency edges for validation, but never parse targets
    // outside the vetted source inventory (including imported symlink targets).
    doNotFollow: { path: `(^|/)node_modules/|^(?!(?:${allowedPaths})$)` },
    baseDir: root,
    ruleSet: { forbidden: config.forbidden },
    validate: true,
    outputType: 'json',
  });
  if (typeof result.output !== 'string')
    throw new Error('Invalid dependency analysis output.');
  const graph = parseGraph(result.output);
  for (const module of graph.modules) {
    if (
      !module.coreModule &&
      !module.source.includes('node_modules/') &&
      /\.(?:[cm]?js|[cm]?tsx?)$/.test(module.source)
    ) {
      const source = normalizePath(module.source, root);
      if (!layerOf(source))
        throw new Error('Unmapped source module discovered during analysis.');
      if (!files.includes(source))
        throw new Error('Source module is outside the vetted inventory.');
    }
    if (
      (module.dependencies ?? []).some(
        (dependency) => dependency.couldNotResolve,
      )
    )
      throw new Error(
        `Unresolved import in ${normalizePath(module.source, root)}.`,
      );
  }
  const entries = graph.summary.violations.map((violation) => {
    const source = graph.modules.find(
      (module) => module.source === violation.from,
    );
    const dependency = source?.dependencies.find(
      (entry) => entry.resolved === violation.to,
    );
    const target = violation.to.includes('node_modules/')
      ? dependency?.module
      : violation.to;
    if (!target) throw new Error('Cannot normalize dependency target.');
    return {
      rule: violation.rule.name,
      source: normalizePath(violation.from, root),
      target: normalizePath(target, root),
    };
  });
  const unique = [
    ...new Map(entries.map((entry) => [entryKey(entry), entry])).values(),
  ].sort((left, right) => entryKey(left).localeCompare(entryKey(right), 'en'));
  return {
    entries: validateEntries(unique),
    modules: graph.modules.length,
  };
}
