import assert from 'node:assert/strict';
import test from 'node:test';

import { NAT } from '@gyblos/config';

import {
  auditCounterDelta,
  classifyPublicPath,
  readAuditCounters,
  readReplyState,
} from '../tooling/public-path-audit.mjs';

const tags = [
  'gyb_public_out_0',
  'gyb_public_in_any',
  'gyb_public_input',
  'gyb_public_forward',
];
function dump(values: number[]) {
  return tags
    .map(
      (tag, index) =>
        `[${values[index]}:0] -A TEST -p udp -m comment --comment ${tag}`,
    )
    .join('\n');
}

test('audit counters require every exact tag once and never treat missing evidence as zero', () => {
  assert.deepEqual(
    readAuditCounters(dump([3, 1, 0, 1]), tags),
    Object.fromEntries(tags.map((tag, index) => [tag, [3, 1, 0, 1][index]])),
  );
  for (const invalid of [
    dump([0, 0, 0, 0]).split('\n').slice(1).join('\n'),
    dump([0, 0, 0, 0]) + '\n' + dump([0, 0, 0, 0]),
    dump([0, 0, 0, 0]).replace('[0:0]', '[bad:0]'),
  ])
    assert.throws(() => readAuditCounters(invalid, tags));
});

test('counter deltas reject resets and preserve unrelated inbound packets as uncertainty', () => {
  assert.deepEqual(auditCounterDelta({ a: 2 }, { a: 5 }), { a: 3 });
  assert.throws(() => auditCounterDelta({ a: 5 }, { a: 2 }));
  assert.throws(() => auditCounterDelta({ a: 2 }, {}));
  assert.equal(
    classifyPublicPath({
      outbound: 4,
      incomingAny: 0,
      incomingInput: 0,
      incomingForward: 0,
    }),
    NAT.publicAudit.outcomes.noReturn,
  );
  assert.equal(
    classifyPublicPath({
      outbound: 0,
      incomingAny: 0,
      incomingInput: 0,
      incomingForward: 0,
    }),
    NAT.publicAudit.outcomes.notExercised,
  );
  assert.equal(
    classifyPublicPath({
      outbound: 4,
      incomingAny: 7,
      incomingInput: 0,
      incomingForward: 0,
    }),
    NAT.publicAudit.outcomes.unattributed,
  );
  assert.equal(
    classifyPublicPath({
      outbound: 4,
      incomingAny: 7,
      incomingKnownReturn: 7,
      incomingPeer: 0,
      incomingInput: 0,
      incomingForward: 0,
    }),
    NAT.publicAudit.outcomes.noPeerReturn,
  );
  assert.equal(
    classifyPublicPath({
      outbound: 4,
      incomingAny: 7,
      incomingInput: 2,
      incomingForward: 0,
    }),
    NAT.publicAudit.outcomes.routerInput,
  );
  assert.equal(
    classifyPublicPath({
      outbound: 4,
      incomingAny: 7,
      incomingInput: 0,
      incomingForward: 2,
    }),
    NAT.publicAudit.outcomes.forwarded,
  );
});

test('UNREPLIED is read explicitly; lack of ASSURED is not proof of no reply', () => {
  const tuple = {
    source: '10.82.11.10',
    destination: '203.0.113.10',
    sourcePort: 43101,
    destinationPort: 50000,
  };
  const line =
    'udp 17 30 src=10.82.11.10 dst=203.0.113.10 sport=43101 dport=50000 STATE src=203.0.113.10 dst=10.82.20.2 sport=50000 dport=43101 mark=0 use=1';
  assert.equal(
    readReplyState(line.replace('STATE', '[UNREPLIED]'), tuple),
    true,
  );
  assert.equal(
    readReplyState('ipv4 2 ' + line.replace('STATE', '[UNREPLIED]'), tuple),
    true,
  );
  assert.equal(
    readReplyState(line.replace('STATE', '[ASSURED]'), tuple),
    false,
  );
  assert.equal(readReplyState(line.replace('STATE', ''), tuple), false);
  assert.equal(readReplyState('', tuple), null);
  assert.throws(() => readReplyState(line + '\n' + line, tuple));
});
