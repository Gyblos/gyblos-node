import assert from 'node:assert/strict';

import { NAT, P2P } from '@gyblos/config';
import { saveJson } from '@gyblos/runtime';

import { containerId, docker, execute } from './docker-command.js';
import type { prepareDocker } from './docker-prepare.js';

interface Inspection {
  Config: { User: string };
  HostConfig: {
    CapAdd: string[];
    CapDrop: string[];
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: { Type: string; Destination: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}
interface InterfaceAddress {
  ifname: string;
  address: string;
  addr_info: { local: string }[];
}

function decodeGateway(value: string) {
  return value
    .match(/../g)!
    .reverse()
    .map((byte) => parseInt(byte, NAT.hexRadix))
    .join('.');
}

export async function inspectNat(
  context: Awaited<ReturnType<typeof prepareDocker>>,
) {
  assert.ok(['nat-direct', 'nat-relay'].includes(context.scenario));
  const routers = [];
  const privateProof: unknown[] = [];
  for (const [side, role, home, other] of [
    ['a', 'seller', NAT.homeA, NAT.homeB],
    ['b', 'buyer', NAT.homeB, NAT.homeA],
  ] as const) {
    const container = await containerId(
      context.project,
      `router-${side}`,
      context.environment,
    );
    const [inspection] = JSON.parse(
      await docker(['inspect', container]),
    ) as Inspection[];
    assert.ok(inspection);
    assert.equal(inspection.Config.User, P2P.docker.user);
    assert.deepEqual(
      inspection.HostConfig.CapAdd.map((capability) =>
        capability.replace(/^CAP_/, ''),
      ),
      ['NET_ADMIN'],
    );
    assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(
      Object.keys(inspection.HostConfig.PortBindings ?? {}).length,
      0,
    );
    assert.ok(
      inspection.Mounts.every(
        (mount) =>
          mount.Type === 'tmpfs' && mount.Destination === NAT.privateMount,
      ),
    );
    assert.equal(Object.keys(inspection.NetworkSettings.Networks).length, 2);
    const status = await execute(container, ['cat', '/proc/1/status']);
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
      assert.equal(
        new RegExp(`^${field}:\\s+(\\w+)$`, 'm').exec(status)?.[1],
        NAT.capabilityMask,
      );
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
    const addresses = JSON.parse(
      await execute(container, ['/sbin/ip', '-j', '-4', 'addr', 'show']),
    ) as InterfaceAddress[];
    const lan = addresses.find((iface) =>
      iface.addr_info.some((info) => info.local === home.router),
    );
    assert.ok(lan);
    assert.ok(lan.addr_info.some((info) => info.local === home.gateway));
    const [actor] = JSON.parse(
      await docker([
        'inspect',
        role === 'buyer' ? context.buyerContainer : context.sellerContainer,
      ]),
    ) as Inspection[];
    assert.ok(actor);
    assert.deepEqual(Object.keys(actor.NetworkSettings.Networks), [
      `${context.project}_home-${side}`,
    ]);
    assert.equal(
      actor.NetworkSettings.Networks[`${context.project}_home-${side}`]!
        .IPAddress,
      home.actor,
    );
    const network = JSON.parse(
      await execute(
        role === 'buyer' ? context.buyerContainer : context.sellerContainer,
        [
          'node',
          '-e',
          `const fs=require('fs');console.log(JSON.stringify({routes:fs.readFileSync('/proc/net/route','utf8'),arp:fs.readFileSync('/proc/net/arp','utf8')}));`,
        ],
      ),
    ) as { routes: string; arp: string };
    const defaults = network.routes
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[1] === '00000000');
    assert.equal(defaults.length, 1);
    assert.equal(decodeGateway(defaults[0]![2]!), home.gateway);
    const gateway = network.arp
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .find((columns) => columns[0] === home.gateway);
    const links = JSON.parse(
      await execute(container, ['/sbin/ip', '-j', 'link', 'show']),
    ) as { ifname: string; address: string }[];
    const routerMac = links.find((link) => link.ifname === lan.ifname)?.address;
    assert.ok(routerMac);
    assert.equal(gateway?.[NAT.procColumns.arpMac], routerMac);
    const rules = await execute(container, [
      '/usr/sbin/iptables-nft',
      '-S',
      'FORWARD',
    ]);
    assert.ok(rules.includes('-P FORWARD DROP'));
    assert.ok(rules.includes(`-d ${other.subnet} -j DROP`));
    const udpBlock = rules
      .split('\n')
      .findIndex((line) => line.includes('-p udp -j DROP'));
    const established = rules
      .split('\n')
      .findIndex((line) => line.includes('ESTABLISHED'));
    if (context.scenario === 'nat-relay' && side === 'a')
      assert.ok(udpBlock >= 0 && udpBlock < established);
    else assert.equal(udpBlock, -1);
    const nat = await execute(container, [
      '/usr/sbin/iptables-nft',
      '-t',
      'nat',
      '-S',
      'POSTROUTING',
    ]);
    assert.ok(
      nat.includes(`-s ${home.subnet}`) && nat.includes('-j MASQUERADE'),
    );
    const counters = await execute(container, [
      '/usr/sbin/iptables-nft',
      '-t',
      'nat',
      '-L',
      'POSTROUTING',
      '-vnx',
    ]);
    const row = counters
      .split('\n')
      .find((line) => line.includes('MASQUERADE'));
    assert.ok(row);
    const [packets, bytes] = row.trim().split(/\s+/).map(Number);
    assert.ok(packets! > 0 && bytes! > 0);
    const forwardCounters = await execute(container, [
      '/usr/sbin/iptables-nft',
      '-L',
      'FORWARD',
      '-vnx',
    ]);
    const forwardedPackets = forwardCounters
      .split('\n')
      .filter((line) => /ACCEPT/.test(line))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0);
    const udpDropRow = forwardCounters
      .split('\n')
      .find((line) => /DROP\s+udp/.test(line));
    const inboundUdpDroppedPackets = udpDropRow
      ? Number(udpDropRow.trim().split(/\s+/)[0])
      : 0;
    privateProof.push({
      side,
      status,
      addresses,
      network,
      rules,
      nat,
      counters,
      forwardCounters,
    });
    routers.push({
      side,
      nonRoot: true,
      capabilities: ['NET_ADMIN'],
      noNewPrivilegesAfterBootstrap: true,
      keyless: true,
      readOnlyRoot: true,
      actorHasOneHomeInterface: true,
      gatewayArpMatchesRouter: true,
      masqueradePackets: packets!,
      masqueradeBytes: bytes!,
      crossHomeRouteBlocked: true,
      inboundUdpDroppedPackets,
      forwardedPackets,
      allInboundUdpBlocked: context.scenario === 'nat-relay' && side === 'a',
    });
  }
  for (const side of ['a', 'b']) {
    const [network] = JSON.parse(
      await docker(['network', 'inspect', `${context.project}_home-${side}`]),
    ) as { Options: Record<string, string> }[];
    assert.equal(
      network?.Options['com.docker.network.bridge.inhibit_ipv4'],
      'true',
    );
    assert.equal(
      network?.Options['com.docker.network.bridge.enable_ip_masquerade'],
      'false',
    );
  }
  await saveJson(NAT.topologyLog, {
    scenario: context.scenario,
    runId: context.runId,
    privateProof,
  });
  return {
    routerCount: routers.length,
    homeBridgeIpv4Inhibited: true,
    actorGatewaysVerified: true,
    routers,
  };
}
