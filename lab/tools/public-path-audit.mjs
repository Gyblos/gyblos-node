import assert from 'node:assert/strict';

import { NAT } from '@gyblos/lab-p2p/constants';
import { parseUdpMappings } from '@gyblos/lab-p2p/nat-mapping';

export function readAuditCounters(output, tags) {
  return Object.fromEntries(
    tags.map((tag) => {
      const lines = output.split('\n').filter((line) => {
        const match = /--comment (?:"([^"]+)"|(\S+))/.exec(line);
        return (match?.[1] ?? match?.[2]) === tag;
      });
      assert.equal(lines.length, 1, 'Missing or ambiguous audit counter.');
      const match = /^\[(\d+):\d+\] /.exec(lines[0]);
      assert.ok(match, 'Malformed audit counter.');
      const packets = Number(match[1]);
      assert.ok(Number.isSafeInteger(packets));
      return [tag, packets];
    }),
  );
}

export function auditCounterDelta(before, after) {
  return Object.fromEntries(
    Object.entries(before).map(([tag, value]) => {
      assert.ok(
        Number.isSafeInteger(after[tag]) && after[tag] >= value,
        'Audit counter disappeared or reset.',
      );
      return [tag, after[tag] - value];
    }),
  );
}

export function classifyPublicPath(counts) {
  const outcomes = NAT.publicAudit.outcomes;
  if (!counts.outbound) return outcomes.notExercised;
  if (!counts.incomingAny) return outcomes.noReturn;
  if (counts.incomingInput) return outcomes.routerInput;
  if (counts.incomingForward) return outcomes.forwarded;
  if (
    counts.incomingPeer === 0 &&
    counts.incomingKnownReturn === counts.incomingAny
  )
    return outcomes.noPeerReturn;
  return outcomes.unattributed;
}

export function readReplyState(output, expected) {
  const matches = output.split('\n').filter((line) => {
    const normalized = line.replace(/^ipv4\s+2\s+/, '');
    if (!/^udp\s/.test(normalized)) return false;
    const [mapping] = parseUdpMappings(normalized);
    return Object.entries(expected).every(
      ([key, value]) => mapping.original[key] === value,
    );
  });
  assert.ok(matches.length <= 1, 'Ambiguous native conntrack tuple.');
  return matches.length ? matches[0].includes('[UNREPLIED]') : null;
}
