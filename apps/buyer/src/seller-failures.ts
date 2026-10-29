// Names why one seller dropped out of a selection: the phase it failed in and a fixed code.
// Codes come from closed catalogs only, so a report never carries error text, addresses or keys.
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import {
  BUYER_SELECTION_CODES,
  ERROR_DIAGNOSTICS,
  SELLER_FAILURES,
  type SellerFailurePhase,
} from './constants';
import { errorDiagnostic } from './diagnostics';
import { BuyerSelectionError } from './selection-config';

export interface SellerFailure {
  nodeId: string;
  phase: SellerFailurePhase;
  code: string;
}
export type SellerFailureReporter = (failure: SellerFailure) => void;

const KNOWN_CODES: ReadonlySet<string> = new Set([
  ...Object.values(CONTROL_CODES),
  ...Object.values(BUYER_SELECTION_CODES),
]);

export function sellerFailureCode(error: unknown): string {
  if (
    (error instanceof ControlError || error instanceof BuyerSelectionError) &&
    KNOWN_CODES.has(error.code)
  )
    return error.code;
  const diagnostic = errorDiagnostic(error);
  return diagnostic === ERROR_DIAGNOSTICS.UNKNOWN
    ? SELLER_FAILURES.UNKNOWN
    : diagnostic;
}

// A reporter that throws must never change which seller wins.
export function reportSellerFailure(
  report: SellerFailureReporter | undefined,
  failure: SellerFailure,
) {
  try {
    report?.(failure);
  } catch {
    // Reporting is best effort.
  }
}
