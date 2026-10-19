import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  docker,
  execute,
  writeContainerFile,
} from '@gyblos/cli/p2p/docker-command';
import {
  FILE_MODES,
  IPV6_LOOPBACK,
  IROH_SDK_VERSION,
  NAT,
  P2P,
} from '@gyblos/config';

import { nativeSource } from './iroh-probe.mjs';
import { startLabObserver } from './lab-observer.mjs';

export async function runNativeProbe({ ids, values, project }) {
  const version = await execute(ids.buyer, [
    'node',
    '-e',
    'process.stdout.write(JSON.parse(require("node:fs").readFileSync("node_modules/@number0/iroh/package.json","utf8")).version)',
  ]);
  assert.equal(version, IROH_SDK_VERSION);
  const config = {
    protocol: NAT.nativeProbe.protocol,
    ipv6Bind: `${IPV6_LOOPBACK}:0`,
    closeCode: P2P.streamCloseCode.toString(),
    maximumStreams: NAT.nativeProbe.maximumStreams,
    samples: NAT.nativeProbe.samples,
    intervalMs: NAT.nativeProbe.intervalMs,
    deadlineMs: NAT.nativeProbe.deadlineMs,
    bytes: NAT.nativeProbe.bytes,
    peerPath: NAT.nativeProbe.peerPath,
    resultPath: NAT.nativeProbe.resultPath,
    active: !values.idle,
  };
  if (values['wan-discovery']) {
    await startLabObserver(ids, config.closeCode);
    config.discovery = {
      ...NAT.discovery,
      closeCode: config.closeCode,
      subnetPrefix: NAT.discovery.observerHost.slice(
        0,
        NAT.discovery.observerHost.lastIndexOf('.') + 1,
      ),
    };
  }
  const server = nativeSource('seller'),
    client = nativeSource('buyer');
  await docker([
    'exec',
    '-d',
    ids.seller,
    'node',
    '--input-type=module',
    '-e',
    server,
    JSON.stringify({
      ...config,
      bind: `${NAT.homeA.actor}:${values['wan-discovery'] ? 0 : NAT.sellerUdpPort}`,
      external: values['lab-candidates']
        ? `${NAT.wan.routerA}:${NAT.sellerUdpPort}`
        : '',
    }),
  ]);
  let peer;
  for (let index = 0; index < P2P.docker.readyMs / P2P.routePollMs; index++) {
    try {
      peer = await execute(ids.seller, ['cat', NAT.nativeProbe.peerPath]);
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
  }
  assert.ok(peer, 'Native seller did not become ready.');
  await writeContainerFile(
    ids.buyer,
    NAT.nativeProbe.peerPath,
    Buffer.from(peer),
  );
  await execute(ids.buyer, [
    'node',
    '--input-type=module',
    '-e',
    client,
    JSON.stringify({
      ...config,
      bind: `${NAT.homeB.actor}:${values['wan-discovery'] ? 0 : NAT.buyerUdpPort}`,
      external: values['lab-candidates']
        ? `${NAT.wan.routerB}:${NAT.buyerUdpPort}`
        : '',
    }),
  ]);
  const raw = JSON.parse(
    await execute(ids.buyer, ['cat', NAT.nativeProbe.resultPath]),
  );
  await writeFile(
    `.local/${project}-native-private.json`,
    JSON.stringify(raw),
    { mode: FILE_MODES.privateFile },
  );
  const selected = raw.snapshots.at(-1).paths.filter((path) => path.isSelected);
  assert.equal(selected.length, 1);
  const firstDirect = raw.snapshots.find((snapshot) =>
    snapshot.paths.some((path) => path.isSelected && path.isIp),
  );
  const native = {
    candidateMode: values['wan-discovery']
      ? NAT.discovery.modes.observed
      : values['lab-candidates']
        ? NAT.discovery.modes.manual
        : NAT.discovery.modes.public,
    active: !values.idle,
    echoes: raw.echoes,
    connectMs: raw.connectMs,
    finalRoute: selected[0].isIp
      ? 'iroh-direct'
      : selected[0].isRelay
        ? 'iroh-relay'
        : 'unknown',
    firstDirectMs: firstDirect ? firstDirect.at - raw.snapshots[0].at : null,
    selectedLabWan:
      selected[0].remoteAddr === `${NAT.wan.routerA}:${NAT.sellerUdpPort}`,
    selectedReflectedAddress: values['wan-discovery']
      ? selected[0].isIp && selected[0].remoteAddr === raw.peer.reflectedAddress
      : null,
    workerSha256: createHash('sha256')
      .update(server)
      .update(client)
      .digest('hex'),
  };
  if (values['block-udp']) assert.equal(native.finalRoute, 'iroh-relay');
  else if (values['wan-discovery']) {
    assert.equal(native.finalRoute, 'iroh-direct');
    assert.equal(native.selectedReflectedAddress, true);
    assert.ok(raw.reflectedAddress);
  } else if (values['lab-candidates']) {
    assert.equal(native.finalRoute, 'iroh-direct');
    assert.equal(native.selectedLabWan, true);
  }
  return { report: native, raw };
}
