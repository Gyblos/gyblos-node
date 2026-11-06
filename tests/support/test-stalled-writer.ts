// An owned synthetic writer must remember cleanup even if its first write starts later.
export function stalledTestWriter() {
  let release = () => {};
  return {
    writeAll: () => new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
}
