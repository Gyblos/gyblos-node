// A read-only summary of the seller's upto ledger for `gyblos seller status`: how many paid requests
// settled, what they charged, and what is still settling. It never takes the ledger's lock or writes;
// the ledger is rewritten atomically, so a read sees one whole document. Finished channels are pruned
// after LEDGER_FILE.minRetentionMs, so the summary covers recent requests, not lifetime earnings.
import { UPTO_CHANNEL_STATES } from 'x402-upto-metered';

import { readPrivateFile } from '@gyblos/runtime/private-file';

import { LEDGER_FILE } from './constants';
import type { UptoLedgerPaths } from './file-ledger';
import { parseLedger } from './ledger-schema';

export interface UptoLedgerSummary {
  // Settled channels changed at or after `since`, and the gross USDC they charged (atomic units,
  // including the protocol fee).
  settled: number;
  chargedAtomic: bigint;
  // Channels still depositing, admitted or settling, whatever their age.
  pending: number;
  // Failed or lapsed channels changed at or after `since`: nothing was charged.
  failed: number;
  lastSettledAt?: number;
}

const PENDING: ReadonlySet<string> = new Set([
  UPTO_CHANNEL_STATES.DEPOSITING,
  UPTO_CHANNEL_STATES.ADMITTED,
  UPTO_CHANNEL_STATES.SETTLING,
]);
const FAILED: ReadonlySet<string> = new Set([
  UPTO_CHANNEL_STATES.FAILED,
  UPTO_CHANNEL_STATES.LAPSED,
]);

// Pure: the summary of one ledger document's text. Throws on a document the ledger itself would refuse.
export function summarizeUptoLedger(
  text: string,
  since: number,
): UptoLedgerSummary {
  const summary: UptoLedgerSummary = {
    settled: 0,
    chargedAtomic: 0n,
    pending: 0,
    failed: 0,
  };
  for (const { record, updatedAt } of Object.values(
    parseLedger(text).channels,
  )) {
    if (PENDING.has(record.state)) summary.pending++;
    else if (updatedAt < since) continue;
    else if (FAILED.has(record.state)) summary.failed++;
    else if (record.state === UPTO_CHANNEL_STATES.SETTLED) {
      summary.settled++;
      summary.chargedAtomic += BigInt(
        record.settlement?.chargedAtomic ?? record.chargedAtomic ?? '0',
      );
      summary.lastSettledAt = Math.max(summary.lastSettledAt ?? 0, updatedAt);
    }
  }
  return summary;
}

// Undefined when this seller has no ledger yet (it never served a paid request). Throws when the file
// is unsafe, too large or invalid.
export async function readUptoLedgerSummary(
  paths: Pick<UptoLedgerPaths, 'state'>,
  since: number,
): Promise<UptoLedgerSummary | undefined> {
  const text = await readPrivateFile(paths.state, LEDGER_FILE.maxBytes);
  return text === undefined ? undefined : summarizeUptoLedger(text, since);
}
