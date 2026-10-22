// Owns laboratory native probe; product code must not depend on this module.
import { Endpoint, RelayMode } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST, P2P } from '@gyblos/config';
import { isMain } from '@gyblos/runtime';

export async function main() {
  const endpoints: Endpoint[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const builder = Endpoint.builder();
      builder.applyMinimal();
      builder.relayMode(RelayMode.disabled());
      builder.alpns([[...Buffer.from(P2P.protocol)]]);
      builder.bindAddr(`${LOCALHOST}:0`);
      builder.bindAddr(`${IPV6_LOOPBACK}:0`);
      endpoints.push(await builder.bind());
    }
    const [seller, buyer] = endpoints;
    if (!seller || !buyer) throw new Error('Probe endpoints missing.');
    const payload = Buffer.from('synthetic-iroh-probe');
    const serving = (async () => {
      const incoming = await seller.acceptNext();
      if (!incoming) throw new Error('Missing peer.');
      const connection = await (await incoming.accept()).connect();
      const stream = await connection.acceptBi();
      const bytes = await stream.recv.readToEnd(P2P.bodyBytes);
      await stream.send.writeAll(bytes);
      await stream.send.finish();
    })();
    const connection = await buyer.connect(seller.addr(), [
      ...Buffer.from(P2P.protocol),
    ]);
    if (!connection.remoteId().equals(seller.id()))
      throw new Error('Identity mismatch.');
    const stream = await connection.openBi();
    await stream.send.writeAll([...payload]);
    await stream.send.finish();
    const reply = Buffer.from(await stream.recv.readToEnd(P2P.bodyBytes));
    if (!reply.equals(payload)) throw new Error('Echo mismatch.');
    await serving;
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        echo: true,
        remoteIdMatches: true,
        allSocketsLoopback: endpoints.every((endpoint) =>
          endpoint
            .boundSockets()
            .every(
              (socket) =>
                socket.startsWith(`${LOCALHOST}:`) ||
                socket.startsWith(`${IPV6_LOOPBACK}:`),
            ),
        ),
        paths: connection.paths().map((path) => ({
          selected: path.isSelected,
          isIp: path.isIp,
          isRelay: path.isRelay,
        })),
      }),
    );
  } finally {
    await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  }
}

if (isMain(import.meta.url)) await main();
