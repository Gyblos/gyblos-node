// Cleanup always runs; its failure is separate evidence and never replaces an earlier failure.
export async function withDiagnosticCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<unknown>,
  observe: (error: unknown) => void,
): Promise<T> {
  let failed = false;
  try {
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      try {
        observe(error);
      } catch {
        /* Diagnostics are observational. */
      }
      if (!failed) throw error;
    }
  }
}
