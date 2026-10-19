import { readFile } from 'node:fs/promises';

import { JOURNAL_FILENAMES, JOURNAL_PATHS } from '@gyblos/config';
import { JOURNAL_STATES } from '@gyblos/gate/constants';
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
      const terminal: readonly string[] = path.endsWith(JOURNAL_FILENAMES.exact)
        ? [JOURNAL_STATES.CONFIRMED, JOURNAL_STATES.REJECTED]
        : path.endsWith(JOURNAL_FILENAMES.inference)
          ? [
              JOURNAL_STATES.VERIFIED,
              JOURNAL_STATES.RECONCILED,
              JOURNAL_STATES.RESOLVED_REJECTED,
            ]
          : [JOURNAL_STATES.VERIFIED, JOURNAL_STATES.RESOLVED_REJECTED];
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
