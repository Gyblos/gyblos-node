// Coordinates a locally confirmed review through the desktop session's serialized operations.
// The renderer never chooses the review fingerprint or amount.
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import type { CheckoutContext } from './paypal-session';

type ReviewTicket = { fingerprint: string; spentCents: number };
export function desktopPaypalReviewActions(
  context: CheckoutContext,
  clearAgent: () => void,
) {
  return {
    reviewAndSettle: (confirm: (ticket: ReviewTicket) => Promise<boolean>) =>
      context.run(async () => {
        const ticket = context.session.reviewTicket();
        if (ticket.spentCents <= 0)
          throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
        if (!(await confirm(ticket)) || context.isClosing())
          return context.status();
        const decidedAt = Date.now();
        await context.session.settleReviewedInference(
          context.orderId(),
          ticket.spentCents,
          ticket.fingerprint,
          decidedAt,
        );
        clearAgent();
        return context.status();
      }),
  };
}
