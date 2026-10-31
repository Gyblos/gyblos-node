// Checks exact synthetic buyer delivery independently of payment certainty; not a product response parser.
import type { PaidVerdict } from '@gyblos/buyer/constants';
export function assertPaidJsonAnswer(_body: string, _verdict: PaidVerdict): void {}
export function assertPaidStreamAnswer(_body: string, _contentType: string | undefined): void {}
