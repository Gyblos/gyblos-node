// Owns strict bounded model-output parsing; source-only decisions never claim executed confirmation.
import {
  MAX_AGENT_OUTPUT_BYTES,
  MAX_FIELD_CHARS,
  MAX_RESPONSE_ITEMS,
  REVIEWER_IDS,
  type ReviewerId,
} from './constants';
import { reviewableFiles } from './inventory';
import type {
  AgentEvidence,
  AgentFinding,
  AgentReviewResponse,
  SourceBundle,
  VerificationResponse,
} from './types';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected a JSON object.');
  return value as JsonObject;
}
function keys(value: JsonObject, expected: string[]): void {
  if (
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Missing or unexpected JSON properties.');
}
function parse(text: string): JsonObject {
  if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_OUTPUT_BYTES)
    throw new Error('Response exceeds byte limit.');
  try {
    return object(JSON.parse(text) as unknown);
  } catch {
    throw new Error('Expected exactly one JSON object.');
  }
}
function string(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_FIELD_CHARS
  )
    throw new Error('Expected a bounded non-empty string.');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_RESPONSE_ITEMS)
    throw new Error('Expected a bounded array.');
  return value;
}
function path(value: unknown): string {
  const result = string(value);
  if (!reviewableFiles([result]).includes(result))
    throw new Error('Invalid repository-relative evidence path.');
  return result;
}
function evidence(value: unknown): AgentEvidence[] {
  const values = array(value);
  if (!values.length) throw new Error('Evidence must not be empty.');
  return values.map((item) => {
    const entry = object(item);
    keys(entry, ['file', 'line', 'revision', 'scope', 'description']);
    if (
      typeof entry.line !== 'number' ||
      !Number.isSafeInteger(entry.line) ||
      entry.line < 1
    )
      throw new Error('Evidence line must be a positive integer.');
    if (entry.revision !== 'head' && entry.revision !== 'base')
      throw new Error('Evidence revision must be head or base.');
    return {
      file: path(entry.file),
      line: entry.line,
      revision: entry.revision,
      scope: string(entry.scope),
      description: string(entry.description),
    };
  });
}
function reviewer(value: unknown): ReviewerId {
  const match = Object.values(REVIEWER_IDS).find((id) => id === value);
  if (match === undefined) throw new Error('Unknown reviewer.');
  return match;
}
function finding(value: unknown): AgentFinding {
  const entry = object(value);
  keys(entry, [
    'fingerprint',
    'category',
    'title',
    'description',
    'evidence',
    'lower_trust_principal',
    'affected_resource',
    'observed_result',
    'suggested_fix',
  ]);
  if (entry.category !== 'security' && entry.category !== 'quality')
    throw new Error('Unknown finding category.');
  return {
    fingerprint: string(entry.fingerprint),
    category: entry.category,
    title: string(entry.title),
    description: string(entry.description),
    evidence: evidence(entry.evidence),
    lower_trust_principal: string(entry.lower_trust_principal),
    affected_resource: string(entry.affected_resource),
    observed_result: string(entry.observed_result),
    suggested_fix: string(entry.suggested_fix),
  };
}
export function parseReviewResponse(text: string): AgentReviewResponse {
  const entry = parse(text);
  keys(entry, ['status', 'reviewer', 'coverage', 'findings']);
  if (entry.status !== 'complete' && entry.status !== 'needs-validation')
    throw new Error('Unknown review status.');
  const coverage = object(entry.coverage);
  keys(coverage, ['reviewed_paths', 'notes']);
  const findings = array(entry.findings).map(finding);
  if (
    new Set(findings.map((item) => item.fingerprint)).size !== findings.length
  )
    throw new Error('Duplicate candidate fingerprint.');
  return {
    status: entry.status,
    reviewer: reviewer(entry.reviewer),
    coverage: {
      reviewed_paths: array(coverage.reviewed_paths).map(path),
      notes: string(coverage.notes),
    },
    findings,
  };
}
export function parseVerificationResponse(text: string): VerificationResponse {
  const entry = parse(text);
  keys(entry, [
    'decision',
    'fingerprint',
    'reason',
    'evidence',
    'blockers',
    'validation_plan',
  ]);
  if (entry.decision !== 'needs_validation' && entry.decision !== 'rejected')
    throw new Error(
      'Source-only verification cannot issue a confirmed decision.',
    );
  const blockers = array(entry.blockers).map(string);
  if (entry.decision === 'needs_validation' && blockers.length === 0)
    throw new Error('Pending validation requires an exact blocker.');
  return {
    decision: entry.decision,
    fingerprint: string(entry.fingerprint),
    reason: string(entry.reason),
    evidence: evidence(entry.evidence),
    blockers,
    validation_plan: string(entry.validation_plan),
  };
}
export function validateEvidence(
  entries: AgentEvidence[],
  bundle: SourceBundle,
): void {
  for (const entry of entries) {
    const source = bundle.files.find(
      (file) => file.path === entry.file && file.revision === entry.revision,
    );
    if (!source || entry.line > source.text.split('\n').length)
      throw new Error('Evidence references unavailable source or line.');
  }
}
export function validateCoverage(
  response: AgentReviewResponse,
  bundle: SourceBundle,
): void {
  const available = [...new Set(bundle.files.map((file) => file.path))].sort();
  const covered = [...new Set(response.coverage.reviewed_paths)].sort();
  if (JSON.stringify(available) !== JSON.stringify(covered))
    throw new Error('Incomplete or invented source coverage.');
  for (const item of response.findings) validateEvidence(item.evidence, bundle);
}
