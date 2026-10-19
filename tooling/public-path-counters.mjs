import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';

import { execute, writeContainerFile } from '@gyblos/cli/p2p/docker-command';
import { FILE_MODES, NAT, P2P } from '@gyblos/config';
import { parseUdpMappings } from '@gyblos/transport/nat-mapping';

import {
  auditCounterDelta,
  classifyPublicPath,
  readAuditCounters,
  readReplyState,
} from './public-path-audit.mjs';

function publicCandidates(addresses) {
  const blocked = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ])
    blocked.addSubnet(address, prefix, 'ipv4');
  return addresses
    .map((value) => value.split(':'))
    .filter(
      ([host, port]) =>
        isIP(host) === NAT.ipv4Family &&
        !blocked.check(host, 'ipv4') &&
        Number(port) > 0 &&
        Number(port) <= NAT.maximumPort,
    )
    .map(([host, port]) => ({ host, port: Number(port) }));
}

export async function startPublicPathCounters(ids, peer) {
  let local;
  for (let index = 0; index < P2P.docker.readyMs / P2P.routePollMs; index++) {
    try {
      local = JSON.parse(
        await execute(ids.buyer, ['cat', NAT.publicAudit.descriptorPath]),
      );
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
  }
  assert.ok(local, 'Public audit did not receive the buyer descriptor.');
  const sides = [];
  for (const [side, own, remote, home, wan] of [
    ['a', peer, local, NAT.homeA.actor, NAT.wan.routerA],
    ['b', local, peer, NAT.homeB.actor, NAT.wan.routerB],
  ]) {
    const candidates = publicCandidates(remote.directAddresses);
    assert.ok(
      candidates.length,
      'Public discovery supplied no IPv4 candidates for the audit.',
    );
    const sourcePort = Number(
      own.boundSockets
        .find((value) => value.startsWith(`${home}:`))
        ?.split(':')[1],
    );
    assert.ok(sourcePort > 0);
    const router = ids[`router-${side}`];
    const interfaces = JSON.parse(
      await execute(router, ['/sbin/ip', '-j', '-4', 'addr', 'show']),
    );
    const iface = interfaces.find((value) =>
      value.addr_info.some((address) => address.local === wan),
    )?.ifname;
    assert.ok(iface);
    const initialConntrack = await execute(router, [
      '/usr/sbin/conntrack',
      '-L',
      '-p',
      'udp',
    ]);
    const knownReturns = parseUdpMappings(initialConntrack).filter(
      (mapping) =>
        mapping.original.source === home &&
        mapping.original.sourcePort === sourcePort &&
        !candidates.some(
          (candidate) => candidate.host === mapping.original.destination,
        ),
    );
    const prefix = NAT.publicAudit.tagPrefix;
    const rules = [
      {
        tag: `${prefix}in_any`,
        table: 'mangle',
        chain: 'PREROUTING',
        match: ['-i', iface, '-p', 'udp'],
      },
      ...candidates.map((candidate, index) => ({
        tag: `${prefix}out_${index}`,
        table: 'filter',
        chain: 'FORWARD',
        match: [
          '-s',
          home,
          '-d',
          candidate.host,
          '-p',
          'udp',
          '--sport',
          String(sourcePort),
          '--dport',
          String(candidate.port),
        ],
      })),
      ...knownReturns.map((mapping, index) => ({
        tag: `${prefix}in_known_${index}`,
        table: 'mangle',
        chain: 'PREROUTING',
        match: [
          '-i',
          iface,
          '-p',
          'udp',
          '-s',
          mapping.reply.source,
          '--sport',
          String(mapping.reply.sourcePort),
          '-d',
          mapping.reply.destination,
          '--dport',
          String(mapping.reply.destinationPort),
        ],
      })),
      ...[...new Set(candidates.map((value) => value.host))].flatMap(
        (host, index) => [
          {
            tag: `${prefix}in_peer_${index}`,
            table: 'mangle',
            chain: 'PREROUTING',
            match: ['-i', iface, '-p', 'udp', '-s', host],
          },
          {
            tag: `${prefix}input_${index}`,
            table: 'filter',
            chain: 'INPUT',
            match: [
              '-i',
              iface,
              '-p',
              'udp',
              '-s',
              host,
              '--dport',
              String(sourcePort),
            ],
          },
          {
            tag: `${prefix}forward_${index}`,
            table: 'filter',
            chain: 'FORWARD',
            match: [
              '-i',
              iface,
              '-p',
              'udp',
              '-s',
              host,
              '-d',
              home,
              '--dport',
              String(sourcePort),
            ],
          },
        ],
      ),
    ];
    // No jump target: these rules count packets and cannot accept or drop them.
    for (const rule of rules)
      await execute(router, [
        '/usr/sbin/iptables-nft',
        '-t',
        rule.table,
        '-I',
        rule.chain,
        ...rule.match,
        '-m',
        'comment',
        '--comment',
        rule.tag,
      ]);
    const tags = rules.map((rule) => rule.tag);
    const before = await execute(router, ['/usr/sbin/iptables-nft-save', '-c']);
    sides.push({
      side,
      router,
      home,
      sourcePort,
      candidates,
      tags,
      initialConntrack,
      before,
      counters: readAuditCounters(before, tags),
    });
  }
  await writeContainerFile(
    ids.buyer,
    NAT.publicAudit.startPath,
    Buffer.from('ready'),
  );
  return async (project) => {
    const reports = [],
      raw = [];
    for (const value of sides) {
      const after = await execute(value.router, [
        '/usr/sbin/iptables-nft-save',
        '-c',
      ]);
      const conntrack = await execute(value.router, [
        '/usr/sbin/conntrack',
        '-L',
        '-p',
        'udp',
        '-o',
        'extended',
      ]);
      const delta = auditCounterDelta(
        value.counters,
        readAuditCounters(after, value.tags),
      );
      const sum = (suffix) =>
        Object.entries(delta)
          .filter(([tag]) => tag.startsWith(NAT.publicAudit.tagPrefix + suffix))
          .reduce((total, [, count]) => total + count, 0);
      const counts = {
        outbound: sum('out_'),
        incomingAny: sum('in_any'),
        incomingPeer: sum('in_peer_'),
        incomingKnownReturn: sum('in_known_'),
        incomingInput: sum('input_'),
        incomingForward: sum('forward_'),
      };
      reports.push({
        router: value.side,
        ...counts,
        classification: classifyPublicPath(counts),
        flows: value.candidates.map((candidate, index) => ({
          candidateIndex: index,
          outboundPackets: delta[`${NAT.publicAudit.tagPrefix}out_${index}`],
          unreplied: readReplyState(conntrack, {
            source: value.home,
            sourcePort: value.sourcePort,
            destination: candidate.host,
            destinationPort: candidate.port,
          }),
        })),
      });
      raw.push({ ...value, after, conntrack });
    }
    await writeFile(
      `.local/${project}-public-path-private.json`,
      JSON.stringify(raw),
      { mode: FILE_MODES.privateFile },
    );
    return { nonTerminatingCounters: true, sides: reports };
  };
}
