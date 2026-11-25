import { PaymentSessionError } from '@gyblos/protocol/payment-session';

// Selection failed before opening a channel or sending a prompt.
export class UnsentSellerChoiceError extends PaymentSessionError {}
