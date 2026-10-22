// Owns laboratory iroh workers; product code must not depend on this module.
import type { Connection } from '@number0/iroh';

import { discoverLabAddress } from './lab-reflection.js';
import type { NativeDescriptor, ObserverConfig, ProbeConfig } from './types.js';

export async function nativeSeller() {
  const { Endpoint, RelayMode } = await import('@number0/iroh');
  const { writeFile } = await import('node:fs/promises');
  const config: ProbeConfig = JSON.parse(process.argv[1]!);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.bindAddr(config.bind);
  builder.bindAddr(config.ipv6Bind);
  builder.alpns([[...Buffer.from(config.protocol)]]);
  builder.relayMode(RelayMode.defaultMode());
  const endpoint = await builder.bind();
  if (config.external) await endpoint.addExternalAddr(config.external);
  await endpoint.online();
  let reflectedAddress = null;
  if (config.discovery) {
    const { EndpointAddr, EndpointId } = await import('@number0/iroh');
    const { readFile } = await import('node:fs/promises');
    const observer = JSON.parse(
      await readFile(config.discovery.descriptorPath, 'utf8'),
    );
    reflectedAddress = await discoverLabAddress(
      endpoint,
      new EndpointAddr(
        EndpointId.fromString(observer.id),
        null,
        observer.addresses,
      ),
      { ...config.discovery, observerId: observer.id },
    );
  }
  if (config.publicAudit)
    await new Promise((resolve) =>
      setTimeout(resolve, config.publicAudit!.settleMs),
    );
  const address = endpoint.addr();
  await writeFile(
    config.peerPath,
    JSON.stringify({
      boundSockets: endpoint.boundSockets(),
      reflectedAddress,
      id: address.id().toString(),
      relayUrl: address.relayUrl(),
      directAddresses: address.directAddresses(),
    }),
  );
  const incoming = await endpoint.acceptNext();
  if (!incoming) throw new Error('No diagnostic connection.');
  const connection = await (await incoming.accept()).connect();
  connection.setMaxConcurrentBiStreams(BigInt(config.maximumStreams));
  try {
    while (true) {
      const stream = await connection.acceptBi();
      const bytes = await stream.recv.readToEnd(config.bytes);
      await stream.send.writeAll(bytes);
      await stream.send.finish();
    }
  } finally {
    await endpoint.close();
  }
}

export async function nativeBuyer() {
  const { Endpoint, EndpointAddr, EndpointId, RelayMode } =
    await import('@number0/iroh');
  const { readFile, writeFile } = await import('node:fs/promises');
  const config: ProbeConfig = JSON.parse(process.argv[1]!);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.bindAddr(config.bind);
  builder.bindAddr(config.ipv6Bind);
  builder.alpns([[...Buffer.from(config.protocol)]]);
  builder.relayMode(RelayMode.defaultMode());
  const endpoint = await builder.bind();
  let connection: Connection | undefined;
  const timer = setTimeout(() => {
    connection?.close(BigInt(config.closeCode), []);
    void endpoint.close();
  }, config.deadlineMs);
  try {
    if (config.external) await endpoint.addExternalAddr(config.external);
    await endpoint.online();
    let reflectedAddress = null;
    if (config.discovery) {
      const observer = JSON.parse(
        await readFile(config.discovery.descriptorPath, 'utf8'),
      );
      reflectedAddress = await discoverLabAddress(
        endpoint,
        new EndpointAddr(
          EndpointId.fromString(observer.id),
          null,
          observer.addresses,
        ),
        { ...config.discovery, observerId: observer.id },
      );
    }
    if (config.publicAudit) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.publicAudit!.settleMs),
      );
      await writeFile(
        config.publicAudit!.descriptorPath,
        JSON.stringify({
          boundSockets: endpoint.boundSockets(),
          directAddresses: endpoint.addr().directAddresses(),
        }),
      );
      const deadline = Date.now() + config.publicAudit!.waitMs;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          await readFile(config.publicAudit!.startPath);
          ready = true;
          break;
        } catch {}
        await new Promise((resolve) =>
          setTimeout(resolve, config.publicAudit!.pollMs),
        );
      }
      if (!ready) throw new Error('Public audit did not release the peer.');
    }
    const peer: NativeDescriptor = JSON.parse(
      await readFile(config.peerPath, 'utf8'),
    );
    const start = performance.now();
    connection = await endpoint.connect(
      new EndpointAddr(
        EndpointId.fromString(peer.id),
        peer.relayUrl,
        peer.directAddresses,
      ),
      [...Buffer.from(config.protocol)],
    );
    if (connection.remoteId().toString() !== peer.id)
      throw new Error('Diagnostic identity mismatch.');
    const connectMs = performance.now() - start;
    const snapshots = [];
    let echoes = 0;
    for (let index = 0; index < config.samples; index++) {
      snapshots.push({ at: performance.now(), paths: connection.paths() });
      if (config.active) {
        const stream = await connection.openBi();
        await stream.send.writeAll([...Buffer.from('synthetic-nonce')]);
        await stream.send.finish();
        const result = await stream.recv.readToEnd(config.bytes);
        if (Buffer.from(result).toString() !== 'synthetic-nonce')
          throw new Error('Diagnostic echo mismatch.');
        echoes++;
      }
      await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
    }
    const remote = await endpoint.remoteAddr(EndpointId.fromString(peer.id));
    await writeFile(
      config.resultPath,
      JSON.stringify({
        boundSockets: endpoint.boundSockets(),
        reflectedAddress,
        connectMs,
        echoes,
        snapshots,
        peer,
        localAddresses: endpoint.addr().directAddresses(),
        learnedAddresses: remote?.directAddresses(),
      }),
    );
  } finally {
    clearTimeout(timer);
    connection?.close(BigInt(config.closeCode), []);
    await endpoint.close();
  }
}

export async function nativeObserver() {
  const { Endpoint, RelayMode } = await import('@number0/iroh');
  const { writeFile } = await import('node:fs/promises');
  const config: ObserverConfig = JSON.parse(process.argv[1]!);
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.bindAddr(config.bind);
  builder.relayMode(RelayMode.disabled());
  builder.alpns([[...Buffer.from(config.protocol)]]);
  const endpoint = await builder.bind();
  await writeFile(
    config.descriptorPath,
    JSON.stringify({
      id: endpoint.id().toString(),
      addresses: endpoint.addr().directAddresses(),
    }),
  );
  try {
    for (let index = 0; index < config.maximumClients; index++) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) throw new Error('Observer closed before reflection.');
      const remote = await incoming.remoteAddr();
      if (remote.kind !== 'ip' || !remote.addr)
        throw new Error('Observer requires direct native UDP.');
      const connection = await (await incoming.accept()).connect();
      try {
        const stream = await connection.acceptBi();
        await stream.recv.readToEnd(config.maximumBytes);
        await stream.send.writeAll([
          ...Buffer.from(JSON.stringify({ address: remote.addr })),
        ]);
        await stream.send.finish();
        await stream.send.stopped();
      } finally {
        connection.close(BigInt(config.closeCode), []);
      }
    }
  } finally {
    await endpoint.close();
  }
}
