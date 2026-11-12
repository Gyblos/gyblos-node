// Isolated local tool-loop acceptance; this entry never accepts operational overrides.
export async function runToolAcceptance(options: { signal?: AbortSignal } = {}): Promise<unknown> {
  void options;
  throw new Error('Tool acceptance not implemented');
}
