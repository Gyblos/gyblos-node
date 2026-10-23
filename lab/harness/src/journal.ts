// Payment journal guard: refuses a new attempt while any gate journal is in a non-terminal state,
// and saves journal records.
import { readFile } from 'node:fs/promises';

import { JOURNAL_FILENAMES, JOURNAL_PATHS } from '@gyblos/config';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';
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
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.UNRESOLVED_ATTEMPT,
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
