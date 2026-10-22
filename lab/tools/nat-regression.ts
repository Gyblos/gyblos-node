// Owns laboratory nat regression; product code must not depend on this module.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { FILE_MODES, P2P } from '@gyblos/config';
import { NAT } from '@gyblos/lab-p2p/constants';
import { docker, execute } from '@gyblos/lab-p2p/docker-command';
import { sourceFingerprint } from '@gyblos/lab-p2p/docker-source';
import {
  advertisedMappingMatches,
  parseUdpMappings,
  selectUdpMapping,
} from '@gyblos/lab-p2p/nat-mapping';
import { natEnvironment } from '@gyblos/lab-p2p/nat-topology';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';

import { assertReflectedMappings } from './lab-mapping.js';
import { addLabObserver } from './lab-observer.js';
import { runNativeProbe } from './native-nat-probe.js';
import type {
  ComposeTemplate,
  ContainerIds,
  ContainerInspection,
  NativeMappings,
} from './types.js';
import { UDP_PROBE_ARGUMENTS, UDP_PROBE_SOURCE } from './udp-probe.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'native-image': { type: 'string' },
      'lab-candidates': { type: 'boolean', default: false },
      idle: { type: 'boolean', default: false },
      'block-udp': { type: 'boolean', default: false },
      'wan-discovery': { type: 'boolean', default: false },
      'trace-public': { type: 'boolean', default: false },
    },
  });
  if (values['trace-public'])
    assert.ok(
      values['native-image'] &&
        !values['wan-discovery'] &&
        !values['lab-candidates'] &&
        !values['block-udp'],
      'Public tracing requires the unchanged native public-discovery mode.',
    );
  const source = await sourceFingerprint();
  const project = `${P2P.docker.projectPrefix}-probe-${randomUUID().slice(0, P2P.docker.projectIdCharacters)}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...natEnvironment(
      values['block-udp'] ? 'nat-relay' : 'nat-direct',
      'gyblos-p2p-unfunded',
    ),
    GYBLOS_P2P_IMAGE: P2P.docker.nodeImage,
    GYBLOS_P2P_USER: P2P.docker.user,
    GYBLOS_P2P_CPUS: String(P2P.docker.cpus),
    GYBLOS_P2P_PIDS: String(P2P.docker.processLimit),
    GYBLOS_P2P_SELLER_MEMORY: P2P.docker.buyerMemory,
    GYBLOS_P2P_BUYER_MEMORY: P2P.docker.buyerMemory,
  };
  if (values['native-image'])
    environment.GYBLOS_P2P_IMAGE = (
      await docker([
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        values['native-image'],
      ])
    ).trim();
  await mkdir('.local', { recursive: true, mode: FILE_MODES.privateDirectory });
  await docker([
    'build',
    '--build-arg',
    `ROUTER_BASE=${NAT.routerBase}`,
    '--build-arg',
    `IPROUTE_VERSION=${NAT.packages.iproute}`,
    '--build-arg',
    `IPTABLES_VERSION=${NAT.packages.iptables}`,
    '--build-arg',
    `LIBCAP_VERSION=${NAT.packages.libcap}`,
    '--build-arg',
    `CONNTRACK_VERSION=${NAT.packages.conntrack}`,
    '-f',
    NAT.routerDockerfile,
    '-t',
    NAT.routerImage,
    '.',
  ]);
  environment.GYBLOS_P2P_ROUTER_IMAGE = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', NAT.routerImage])
  ).trim();
  const template: ComposeTemplate = JSON.parse(
    await readFile(NAT.composePath, 'utf8'),
  );
  delete template.volumes;
  for (const role of ['seller', 'buyer']) {
    const actor = template.services[role]!;
    delete actor.volumes;
    actor.tmpfs = [`${NAT.privateMount}:uid=1000,gid=1000,mode=0700`];
    actor.environment = {};
    actor.command = ['node', '-e', `setInterval(() => {}, ${P2P.routePollMs})`];
    assert.equal(actor.user, '${GYBLOS_P2P_USER}');
    assert.deepEqual(actor.cap_drop, ['ALL']);
    assert.equal(actor.cap_add, undefined);
    assert.equal(actor.privileged, undefined);
    assert.equal(actor.network_mode, undefined);
    assert.equal(actor.ports, undefined);
  }
  addLabObserver(template, values);
  const composePath = `.local/${project}.json`;
  await writeFile(composePath, JSON.stringify(template), {
    mode: FILE_MODES.privateFile,
  });
  const compose = (args: string[]) => [
    'compose',
    '-p',
    project,
    '-f',
    composePath,
    ...args,
  ];
  try {
    await docker(compose(['up', '-d', '--wait']), undefined, environment);
    const ids: ContainerIds = {};
    for (const role of Object.keys(template.services)) {
      ids[role] = (
        await docker(compose(['ps', '-q', role]), undefined, environment)
      ).trim();
      const inspections: ContainerInspection[] = JSON.parse(
        await docker(['inspect', ids[role]!]),
      );
      const inspection = inspections[0]!;
      assert.equal(inspection.Config.User, P2P.docker.user);
      assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspection.HostConfig.Privileged, false);
      assert.ok(inspection.Mounts.every((mount) => mount.Type === 'tmpfs'));
      assert.equal(
        Object.keys(inspection.HostConfig.PortBindings ?? {}).length,
        0,
      );
      assert.equal(
        Object.keys(inspection.NetworkSettings.Networks).length,
        role.startsWith('router') ? 2 : 1,
      );
      const capabilities = (inspection.HostConfig.CapAdd ?? []).map(
        (capability) => capability.replace(/^CAP_/, ''),
      );
      assert.deepEqual(
        capabilities,
        role.startsWith('router') ? ['NET_ADMIN'] : [],
      );
    }
    const run = (
      role: string,
      own: string,
      port: number,
      remote: string,
      remotePort: number,
    ) =>
      execute(ids[role]!, [
        'node',
        '-e',
        UDP_PROBE_SOURCE,
        own,
        String(port),
        remote,
        String(remotePort),
        ...UDP_PROBE_ARGUMENTS,
      ]);
    const [seller, buyer] = await Promise.all([
      run(
        'seller',
        NAT.homeA.actor,
        NAT.probe.sellerPort,
        NAT.wan.routerB,
        NAT.probe.buyerPort,
      ),
      new Promise((resolve) => setTimeout(resolve, NAT.probe.skewMs)).then(() =>
        run(
          'buyer',
          NAT.homeB.actor,
          NAT.probe.buyerPort,
          NAT.wan.routerA,
          NAT.probe.sellerPort,
        ),
      ),
    ]);
    const results = [JSON.parse(seller), JSON.parse(buyer)];
    if (!values['block-udp'])
      assert.ok(
        results.every((result) => result.received > 0),
        'Skewed hole punching failed.',
      );
    const mappings = [];
    for (const [side, own, port, remote, remotePort, wan] of [
      [
        'a',
        NAT.homeA.actor,
        NAT.probe.sellerPort,
        NAT.wan.routerB,
        NAT.probe.buyerPort,
        NAT.wan.routerA,
      ],
      [
        'b',
        NAT.homeB.actor,
        NAT.probe.buyerPort,
        NAT.wan.routerA,
        NAT.probe.sellerPort,
        NAT.wan.routerB,
      ],
    ] as const) {
      const raw = await execute(ids[`router-${side}`]!, [
        '/usr/sbin/conntrack',
        '-L',
        '-p',
        'udp',
      ]);
      const mapping = selectUdpMapping(parseUdpMappings(raw), {
        source: own,
        destination: remote,
        sourcePort: port,
        destinationPort: remotePort,
      });
      if (!values['block-udp']) {
        assert.equal(
          advertisedMappingMatches(mapping, { host: wan, port }),
          true,
        );
        assert.equal(mapping.assured, true);
      }
      mappings.push(mapping);
    }
    const nativeResult = values['native-image']
      ? await runNativeProbe({ ids, values, project })
      : undefined;
    const native = nativeResult?.report;
    const nativeMappings: NativeMappings = {};
    if (native) {
      for (const side of ['a', 'b'])
        nativeMappings[side] = parseUdpMappings(
          await execute(ids[`router-${side}`]!, [
            '/usr/sbin/conntrack',
            '-L',
            '-p',
            'udp',
          ]),
        );
    }
    if (values['wan-discovery']) {
      assertReflectedMappings(nativeResult!.raw, nativeMappings);
      native!.reflectedMappingsVerified = true;
    }
    let inboundUdpDroppedPackets = 0;
    if (values['block-udp']) {
      const counters = await execute(ids['router-a']!, [
        '/usr/sbin/iptables-nft',
        '-L',
        'FORWARD',
        '-vnx',
      ]);
      const row = counters.split('\n').find((line) => /DROP\s+udp/.test(line));
      assert.ok(row, 'The inbound UDP drop rule is missing.');
      inboundUdpDroppedPackets = Number(row.trim().split(/\s+/)[0]);
      assert.ok(
        inboundUdpDroppedPackets > 0,
        'The UDP block was not exercised.',
      );
    }
    const report = {
      status: 'passed',
      source,
      payments: 0,
      roleVolumes: false,
      actorsUnprivileged: true,
      routerImage: environment.GYBLOS_P2P_ROUTER_IMAGE,
      nodeImage: P2P.docker.nodeImage,
      workerSha256: createHash('sha256').update(UDP_PROBE_SOURCE).digest('hex'),
      skewMs: NAT.probe.skewMs,
      packetsReceived: results.map((result) => result.received),
      portsPreserved: values['block-udp'] ? null : true,
      actorImage: environment.GYBLOS_P2P_IMAGE,
      inboundUdpBlocked: values['block-udp'],
      inboundUdpDroppedPackets,
      native,
    };
    await writeFile(
      `.local/${project}-private.json`,
      JSON.stringify({ report, mappings, nativeMappings }),
      { mode: FILE_MODES.privateFile },
    );
    console.log(JSON.stringify(report));
  } finally {
    await docker(compose(['down', '--remove-orphans']), undefined, environment);
  }
}

await withExclusiveLock(P2P.docker.lock, main);
