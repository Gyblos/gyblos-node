// Verifies safe operational envelopes, catalog validation and nonthrowing sinks.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiagnostics,
  type DiagnosticRecord,
} from '@gyblos/runtime/diagnostics';

const CATALOG = {
  component: 'synthetic',
  operation: 'request',
  phases: ['execute'],
  codes: ['FAILED'],
} as const;

void test('diagnostics retain phase and canonical code without copying unknown fields', () => {
  const records: DiagnosticRecord[] = [];
  const diagnostics = createDiagnostics({
    ...CATALOG,
    sink: (record) => records.push(record),
  });
  const event = {
    phase: CATALOG.phases[0],
    code: CATALOG.codes[0],
    message: 'SECRET-CANARY',
  };
  diagnostics.start().report(event);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.phase, CATALOG.phases[0]);
  assert.equal(records[0]?.code, CATALOG.codes[0]);
  assert.ok(!JSON.stringify(records).includes('SECRET-CANARY'));
});

void test('diagnostics ignore getters, reject unknown codes and isolate a throwing sink', () => {
  let accessed = false;
  const records: DiagnosticRecord[] = [];
  const channel = createDiagnostics({
    ...CATALOG,
    sink: (record) => records.push(record),
  });
  const event = {
    phase: CATALOG.phases[0],
    code: CATALOG.codes[0],
    get message() {
      accessed = true;
      throw new Error('SECRET-CANARY');
    },
    toJSON() {
      throw new Error('SECRET-CANARY');
    },
  };
  channel.start().report(event);
  assert.equal(accessed, false);
  assert.equal(records.length, 1);
  const unsafe = { phase: CATALOG.phases[0], code: CATALOG.codes[0] };
  Object.defineProperty(unsafe, 'code', { value: 'SECRET-CANARY' });
  channel.start().report(unsafe);
  assert.equal(records.length, 1);
  assert.equal(channel.health().dropped, 1);
  const broken = createDiagnostics({
    ...CATALOG,
    sink: () => {
      throw new Error('synthetic');
    },
  });
  assert.doesNotThrow(() =>
    broken.start().report({ phase: CATALOG.phases[0], code: CATALOG.codes[0] }),
  );
  assert.equal(broken.health().dropped, 1);
});
