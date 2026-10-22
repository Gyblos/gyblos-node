// Owns validation of dependency-cruiser's JSON boundary.
// It accepts only graph metadata and must never trust unvalidated JSON casts.
export interface BoundaryDependency {
  module: string;
  resolved: string;
  couldNotResolve: boolean;
}

export interface BoundaryModule {
  source: string;
  coreModule: boolean;
  dependencies: BoundaryDependency[];
}

export interface BoundaryViolation {
  rule: { name: string };
  from: string;
  to: string;
}

export interface BoundaryGraph {
  modules: BoundaryModule[];
  summary: { violations: BoundaryViolation[] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependency(value: unknown): BoundaryDependency {
  if (
    !isRecord(value) ||
    typeof value.module !== 'string' ||
    typeof value.resolved !== 'string' ||
    typeof value.couldNotResolve !== 'boolean'
  )
    throw new Error('Invalid dependency analysis edge.');
  return {
    module: value.module,
    resolved: value.resolved,
    couldNotResolve: value.couldNotResolve,
  };
}

function sourceModule(value: unknown): BoundaryModule {
  if (
    !isRecord(value) ||
    typeof value.source !== 'string' ||
    !Array.isArray(value.dependencies) ||
    (value.coreModule !== undefined && typeof value.coreModule !== 'boolean')
  )
    throw new Error('Invalid dependency analysis module.');
  return {
    source: value.source,
    coreModule: value.coreModule === true,
    dependencies: value.dependencies.map(dependency),
  };
}

function violation(value: unknown): BoundaryViolation {
  if (
    !isRecord(value) ||
    !isRecord(value.rule) ||
    typeof value.rule.name !== 'string' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string'
  )
    throw new Error('Invalid dependency analysis violation.');
  return { rule: { name: value.rule.name }, from: value.from, to: value.to };
}

export function parseGraph(text: string): BoundaryGraph {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    !Array.isArray(value.modules) ||
    !isRecord(value.summary) ||
    !Array.isArray(value.summary.violations)
  )
    throw new Error('Invalid dependency analysis result.');
  return {
    modules: value.modules.map(sourceModule),
    summary: { violations: value.summary.violations.map(violation) },
  };
}
