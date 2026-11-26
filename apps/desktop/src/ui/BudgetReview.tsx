import { X402_ACTION } from '../x402-model';
import { Button } from './UI';
import type { X402View } from './useX402';

export function BudgetReview({
  buyer,
  copyError,
}: {
  buyer: X402View;
  copyError: string;
}) {
  const { summary } = buyer.state;
  return (
    <>
      {(buyer.state.error || copyError || summary.blocked) && (
        <p role="status">
          {copyError ||
            buyer.state.error ||
            'An unfinished payment needs review. New messages are blocked.'}
        </p>
      )}
      {(summary.blocked || buyer.state.canCheckChannels) &&
        summary.available && (
          <Button
            disabled={buyer.busy}
            onClick={() => void buyer.run({ action: X402_ACTION.REVIEW })}
          >
            {summary.blocked ? 'Check payment status' : 'Check channel status'}
          </Button>
        )}
    </>
  );
}
