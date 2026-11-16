// A read-only summary of recent seller charges and pending requests, never lifetime earnings.
// No lock or write: atomic ledger replacement lets each read see one whole document.
// Missing or contradictory settlement amounts make the summary unavailable.
import {
  UPTO_CHANNEL_STATES,
  type UptoChannelRecord,
  type UptoChannelState,
} from 'x402-upto-metered';

import {
  checkPrivateDirectory,
  readPrivateFile,
} from '@gyblos/runtime/private-file';

import { LEDGER_FILE } from './constants';
import type { UptoLedgerPaths } from './file-ledger';
import { parseLedger, unavailable } from './ledger-schema';

export interface UptoLedgerSummary {
  // Settled channels changed within [since, now] with a recorded settlement amount, and the gross USDC
  // they charged (atomic units, including the protocol fee).
  settled: number;
  chargedAtomic: bigint;
  // Channels still depositing, admitted or settling, whatever their age.
  pending: number;
  // Failed or lapsed channels changed within [since, now]: nothing was charged.
  failed: number;
  lastSettledAt?: number;
}

const PENDING: ReadonlySet<UptoChannelState> = new Set([
  UPTO_CHANNEL_STATES.DEPOSITING,
  UPTO_CHANNEL_STATES.ADMITTED,
  UPTO_CHANNEL_STATES.SETTLING,
]);
const FAILED: ReadonlySet<UptoChannelState> = new Set([
  UPTO_CHANNEL_STATES.FAILED,
  UPTO_CHANNEL_STATES.LAPSED,
]);

// The amount a settled channel charged, only when its settlement records one consistently; a settled
// record without that evidence is not shown as a confirmed charge (of zero or anything else).
function settledAmount(record: UptoChannelRecord): bigint {
  const charged = record.settlement?.chargedAtomic;
  if (
    charged === undefined ||
    (record.chargedAtomic !== undefined && record.chargedAtomic !== charged)
  )
    return unavailable();
  return BigInt(charged);
}

// Pure: the summary of one ledger document's text over [since, now]. A finished channel dated outside
// that window, in the future or not a safe time, is left out; pending channels count whatever their date.
// Throws on a document the ledger itself would refuse.
export function summarizeUptoLedger(
  text: string,
  since: number,
  now: number,
): UptoLedgerSummary {
  if (
    !Number.isSafeInteger(since) ||
    !Number.isSafeInteger(now) ||
    !Number.isFinite(new Date(since).getTime()) ||
    !Number.isFinite(new Date(now).getTime()) ||
    since > now
  )
    return unavailable();
  const summary: UptoLedgerSummary = {
    settled: 0,
    chargedAtomic: 0n,
    pending: 0,
    failed: 0,
  };
  for (const { record, updatedAt } of Object.values(
    parseLedger(text).channels,
  )) {
    if (PENDING.has(record.state)) {
      summary.pending++;
      continue;
    }
    if (
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < since ||
      updatedAt > now
    )
      continue;
    if (FAILED.has(record.state)) summary.failed++;
    else if (record.state === UPTO_CHANNEL_STATES.SETTLED) {
      const charged = settledAmount(record);
      summary.settled++;
      summary.chargedAtomic += charged;
      summary.lastSettledAt = Math.max(summary.lastSettledAt ?? 0, updatedAt);
    }
  }
  return summary;
}

// Undefined when this seller has no payment directory or ledger yet (it never served a paid request).
// Throws when the directory or file is unsafe (a link, shared permissions, another owner), too large or
// invalid. Creates nothing.
export async function readUptoLedgerSummary(
  paths: Pick<UptoLedgerPaths, 'directory' | 'state'>,
  since: number,
  now: number,
): Promise<UptoLedgerSummary | undefined> {
  if (!(await checkPrivateDirectory(paths.directory))) return undefined;
  const text = await readPrivateFile(paths.state, LEDGER_FILE.maxBytes);
  return text === undefined ? undefined : summarizeUptoLedger(text, since, now);
}
