// Produces evidence only after the owned services finish teardown.
export async function finishPaidAcceptance<T>(close: () => Promise<void>, evidence: () => T): Promise<T> {
  const result = evidence();
  await close();
  return result;
}
