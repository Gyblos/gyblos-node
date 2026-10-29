// Isolates startup acceptance; this assertion scaffold is replaced after the red run.
import { ACCEPTANCE_CODES } from './constants';
import { AcceptanceError } from './errors';
import type { ReceiptAcceptanceReport } from './receipt-constants';
export async function runReceiptAcceptance(_options:{signal?:AbortSignal}={}):Promise<ReceiptAcceptanceReport>{throw new AcceptanceError(ACCEPTANCE_CODES.FAILED);}
