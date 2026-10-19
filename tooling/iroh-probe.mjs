export async function nativeSeller() {
  const { Endpoint, RelayMode } = await import('@number0/iroh');
  const { writeFile } = await import('node:fs/promises');
  const config = JSON.parse(process.argv[1]);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.bindAddr(config.bind);
  builder.bindAddr(config.ipv6Bind);
  builder.alpns([[...Buffer.from(config.protocol)]]);
  builder.relayMode(RelayMode.defaultMode());
  const endpoint = await builder.bind();
  if (config.external) await endpoint.addExternalAddr(config.external);
  await endpoint.online();
  const address = endpoint.addr();
  await writeFile(
    config.peerPath,
    JSON.stringify({
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
  const config = JSON.parse(process.argv[1]);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.bindAddr(config.bind);
  builder.bindAddr(config.ipv6Bind);
  builder.alpns([[...Buffer.from(config.protocol)]]);
  builder.relayMode(RelayMode.defaultMode());
  const endpoint = await builder.bind();
  let connection;
  const timer = setTimeout(() => {
    connection?.close(BigInt(config.closeCode), []);
    void endpoint.close();
  }, config.deadlineMs);
  try {
    if (config.external) await endpoint.addExternalAddr(config.external);
    await endpoint.online();
    const peer = JSON.parse(await readFile(config.peerPath, 'utf8'));
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

export function nativeSource(role) {
  return `await (${(role === 'seller' ? nativeSeller : nativeBuyer).toString()})();`;
}
