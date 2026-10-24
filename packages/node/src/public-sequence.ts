// Reserves durable public-v2 sequence numbers before any signing; no keys or payment state.
import type { HomeEnvironment } from '@gyblos/config/home';

export async function openSellerSequence(options: {environment: HomeEnvironment; nodeId: string; initialFloor?: number}) {
  void options;
  throw new Error('Not implemented');
  return {next: async (minimum = 0): Promise<number> => minimum};
}
