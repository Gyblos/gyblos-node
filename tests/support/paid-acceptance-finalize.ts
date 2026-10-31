// Produces evidence only after the owned services finish teardown.
export async function finishPaidAcceptance<T>(
  close: () => Promise<void>,
  evidence: () => T,
): Promise<T> {
  await close();
  return evidence();
}
