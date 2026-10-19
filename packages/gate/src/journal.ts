import { readFile } from 'node:fs/promises';

import { COMMITMENT, localPath } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';

export async function assertNoUnresolvedAuthorizations(
  paths = [
    localPath('attempt.json'),
    localPath('failure-F1-attempt.json'),
    localPath('failure-F2-attempt.json'),
    localPath('exact-attempt.json'),
    localPath('inference-attempt.json'),
  ],
) {
  for (const path of paths) {
    try {
      const previous = JSON.parse(await readFile(path, 'utf8')) as {
        state?: string;
      };
      const terminal = path.endsWith('exact-attempt.json')
        ? [COMMITMENT, 'rejected']
        : path.endsWith('inference-attempt.json')
          ? ['verified', 'reconciled', 'resolved-rejected']
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
