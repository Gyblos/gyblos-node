import { readFile } from 'node:fs/promises';
import { GateError } from '../packages/payments-x402/src/chain.js';

export async function assertNoUnresolvedAuthorizations(
  paths = [
    '.local/devnet/attempt.json',
    '.local/devnet/failure-F1-attempt.json',
    '.local/devnet/failure-F2-attempt.json',
    '.local/devnet/exact-attempt.json',
    '.local/devnet/inference-attempt.json',
  ],
) {
  for (const path of paths) {
    try {
      const previous = JSON.parse(await readFile(path, 'utf8')) as {
        state?: string;
      };
      const terminal = path.endsWith('exact-attempt.json')
        ? ['confirmed', 'rejected']
        : ['verified', 'resolved-rejected'];
      if (!terminal.includes(previous.state ?? ''))
        throw new GateError(
          'UNRESOLVED_ATTEMPT',
          `Authorization may be unsettled. Reconcile ${path} before another attempt.`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
