// Serializes sandbox session closure with the amount confirmed by the local user.
// The confirmation receives no order identifiers or payment credentials.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import type { CheckoutContext } from './paypal-session';

type FinishSummary = { spentCents: number; limitCents: number };

export function desktopPaypalFinishActions(
  context: CheckoutContext,
  clearAgent: () => void,
) {
  return {
    finish: () =>
      context.run(async () => {
        await context.session.finish(context.orderId());
        clearAgent();
        return context.status();
      }),
    finishWithConfirmation: (
      confirm: (summary: FinishSummary) => Promise<boolean>,
    ) =>
      context.run(async () => {
        const current = context.session.status();
        if (current.phase !== PAYPAL_SESSION_PHASE.ACTIVE || !current.orderId)
          throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
        const approved = await confirm({
          spentCents: current.spentCents,
          limitCents: current.limitCents,
        });
        if (!approved || context.isClosing()) return context.status();
        const latest = context.session.status();
        if (
          latest.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
          latest.orderId !== current.orderId ||
          latest.spentCents !== current.spentCents ||
          latest.limitCents !== current.limitCents
        )
          throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
        await context.session.finish(current.orderId);
        clearAgent();
        return context.status();
      }),
  };
}
