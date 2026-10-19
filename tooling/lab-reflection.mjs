/** Discover one lab-only candidate using the endpoint's own native UDP socket. */
export async function discoverLabAddress(endpoint, observer, config) {
  let timer;
  let active = true;
  try {
    return await Promise.race([
      (async () => {
        let connection;
        try {
          connection = await endpoint.connect(observer, [
            ...Buffer.from(config.protocol),
          ]);
          if (!active) throw new Error('Lab discovery expired.');
          if (connection.remoteId().toString() !== config.observerId)
            throw new Error('Untrusted discovery observer.');
          if (!connection.paths().some((path) => path.isSelected && path.isIp))
            throw new Error('Discovery observer was not reached directly.');
          const stream = await connection.openBi();
          await stream.send.finish();
          const raw = await stream.recv.readToEnd(config.maximumBytes);
          const { address } = JSON.parse(Buffer.from(raw).toString());
          const match =
            typeof address === 'string'
              ? /^(\d{1,3}(?:\.\d{1,3}){3}):([1-9]\d{0,4})$/.exec(address)
              : null;
          if (
            !match ||
            match[0] !== address ||
            !match[1].startsWith(config.subnetPrefix) ||
            match[1].split('.').some((part) => Number(part) > 255) ||
            Number(match[2]) > 65535
          )
            throw new Error('Invalid lab reflection address.');
          if (!active) throw new Error('Lab discovery expired.');
          await endpoint.addExternalAddr(address);
          return address;
        } finally {
          connection?.close(BigInt(config.closeCode), []);
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          void endpoint.close();
          reject(new Error('Lab discovery timed out.'));
        }, config.timeoutMs);
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
