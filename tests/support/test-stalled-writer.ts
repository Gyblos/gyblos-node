// Creates the blocked write before execution so cleanup also releases any write that starts later.
export function stalledTestWriter() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { writeAll: () => pending, release };
}
