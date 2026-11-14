// Names why one seller dropped out of a selection: the phase it failed in and a fixed code.
// Codes come from closed catalogs only, so a report never carries error text, addresses or keys.
import { CONTROL_CODES, type ControlCode } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import {
  BUYER_SELECTION_CODES,
  ERROR_DIAGNOSTICS,
  SELLER_FAILURES,
  type ErrorDiagnosticCode,
  type SellerFailurePhase,
} from './constants';
import { errorDiagnostic } from './diagnostics';
import { BuyerSelectionError } from './selection-config';

type BuyerSelectionCode =
  (typeof BUYER_SELECTION_CODES)[keyof typeof BUYER_SELECTION_CODES];
export type SellerFailureCode =
  | ControlCode
  | BuyerSelectionCode
  | ErrorDiagnosticCode
  | (typeof SELLER_FAILURES)['IDENTITY' | 'DISCOVERY' | 'UNKNOWN'];
export interface SellerFailure {
  nodeId: string;
  phase: SellerFailurePhase;
  code: SellerFailureCode;
}
export type SellerFailureReporter = (failure: SellerFailure) => unknown;

const KNOWN_CODES: readonly (ControlCode | BuyerSelectionCode)[] = [
  ...Object.values(CONTROL_CODES),
  ...Object.values(BUYER_SELECTION_CODES),
];

export function sellerFailureCode(error: unknown): SellerFailureCode {
  try {
    if (error instanceof ControlError || error instanceof BuyerSelectionError) {
      // Read once: a hostile getter must not pass the check and then change.
      const candidate: unknown = error.code;
      const known = KNOWN_CODES.find((code) => code === candidate);
      if (known) return known;
    }
  } catch {
    // A hostile thrown value is reported as unknown.
  }
  const diagnostic = errorDiagnostic(error);
  return diagnostic === ERROR_DIAGNOSTICS.UNKNOWN
    ? SELLER_FAILURES.UNKNOWN
    : diagnostic;
}

// Best effort: a reporter that throws or rejects never changes which seller wins.
export function reportSellerFailure(
  report: SellerFailureReporter | undefined,
  failure: SellerFailure,
) {
  try {
    void Promise.resolve(report?.(failure)).catch(() => {});
  } catch {
    // Reporting is best effort.
  }
}

// Why a seller refused a quote. A seller older than tool calling (before the quote's `tools` field, e.g.
// v0.1.0-beta.9) refuses a quote that asks for tools as an invalid request: that is the same answer as
// "no tools", not a fault, so it is reported as one and does not cool the seller down for the requests
// without tools it still serves.
export function quoteFailureCode(
  error: unknown,
  asksTools: boolean,
): SellerFailureCode {
  const code = sellerFailureCode(error);
  return asksTools && code === CONTROL_CODES.INVALID
    ? CONTROL_CODES.TOOLS
    : code;
}
