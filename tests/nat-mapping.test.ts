// Owns offline nat mapping.test regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advertisedMappingMatches,
  parseUdpMappings,
  selectUdpMapping,
} from '@gyblos/lab-p2p/nat-mapping';

const original = {
  source: '192.0.2.10',
  destination: '198.51.100.3',
  sourcePort: 44102,
  destinationPort: 44101,
};
const changed =
  'udp 17 29 src=192.0.2.10 dst=198.51.100.3 sport=44102 dport=44101 [UNREPLIED] src=198.51.100.3 dst=198.51.100.2 sport=44101 dport=47129 mark=0 use=1';

void test('actual reply tuple detects remapping even when a manual candidate keeps the original port', () => {
  const mapping = selectUdpMapping(parseUdpMappings(changed), original);
  assert.equal(mapping.reply.destinationPort, 47129);
  assert.equal(
    advertisedMappingMatches(mapping, { host: '198.51.100.2', port: 44102 }),
    false,
  );
  assert.equal(
    advertisedMappingMatches(mapping, { host: '198.51.100.2', port: 47129 }),
    true,
  );
});

void test('mapping selection ignores unrelated inbound traffic and rejects ambiguous or missing correlations', () => {
  const inbound =
    'udp 17 29 src=198.51.100.3 dst=198.51.100.2 sport=44101 dport=44102 [UNREPLIED] src=198.51.100.2 dst=198.51.100.3 sport=44102 dport=44101 mark=0 use=1';
  const rows = parseUdpMappings(
    inbound +
      '\n' +
      changed +
      '\nconntrack v1.4.8: 2 flow entries have been shown.',
  );
  assert.equal(selectUdpMapping(rows, original).original.source, '192.0.2.10');
  assert.throws(
    () => selectUdpMapping([...rows, rows[1]!], original),
    /ambiguous/,
  );
  assert.throws(() => selectUdpMapping([], original), /missing/);
});

void test('UDP mapping parser rejects incomplete or invalid kernel tuples', () => {
  for (const row of [
    changed.replace('dport=47129', ''),
    changed.replace('sport=44102', 'sport=999999'),
    changed.replace('src=192.0.2.10', 'src=invalid'),
  ])
    assert.throws(() => parseUdpMappings(row));
});
