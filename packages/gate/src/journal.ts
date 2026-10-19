import { readFile } from 'node:fs/promises';

import { COMMITMENT, JOURNAL_FILENAMES, JOURNAL_PATHS } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';
import { saveJson } from '@gyblos/runtime';

import type { GateJournalRecord, JournalStateRecord } from './journal-types.js';

export async function assertNoUnresolvedAuthorizations(
  paths = [
    JOURNAL_PATHS.fixed,
    JOURNAL_PATHS.f1,
    JOURNAL_PATHS.f2,
    JOURNAL_PATHS.exact,
    JOURNAL_PATHS.inference,
  ],
) {
  for (const path of paths) {
    try {
      const previous = JSON.parse(
        await readFile(path, 'utf8'),
      ) as JournalStateRecord;
      const terminal = path.endsWith(JOURNAL_FILENAMES.exact)
        ? [COMMITMENT, 'rejected']
        : path.endsWith(JOURNAL_FILENAMES.inference)
          ? ['verified', 'reconciled', 'resolved-rejected']
          : ['verified', 'resolved-rejected'];
      if (!terminal.includes(previous.state ?? ''))
        throw new GateError(
          GATE_ERROR_CODES.UNRESOLVED_ATTEMPT,
          `Authorization may be unsettled. Reconcile ${path} before another attempt.`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function saveJournal(path: string, record: GateJournalRecord) {
  await saveJson(path, record);
}
