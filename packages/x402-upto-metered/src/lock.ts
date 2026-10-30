// Serializes work per key within one process, so checks and writes for one channel never interleave.
export function keyedLock() {
  const tails = new Map<string, Promise<void>>();
  return async function locked<T>(
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
