// Presents checkout actions without holding payment credentials or provider URLs.
import type { PaypalChatController } from '../paypal-chat';
import { BUTTON_VARIANT } from './constants';
import { Button } from './UI';

export function CheckStatus({
  chat,
  state,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  return (
    <Button
      disabled={state.busy}
      onClick={() => {
        void chat.refresh();
      }}
    >
      Check status
    </Button>
  );
}

export function PaypalCheckoutActions({
  chat,
  state,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  return (
    <>
      <p>
        Approve in PayPal and Gyblos checks the return automatically. If the
        session does not start, check the approval below.
      </p>
      <Button
        disabled={state.busy || !state.status?.approvalLinkAvailable}
        onClick={() => {
          void chat.openApproval();
        }}
      >
        Open PayPal Sandbox
      </Button>
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={state.busy}
        onClick={() => {
          void chat.approve();
        }}
      >
        Check approval and start session
      </Button>
      <Button
        disabled={state.busy}
        onClick={() => {
          void chat.abandon();
        }}
      >
        Abandon checkout in Gyblos
      </Button>
    </>
  );
}
