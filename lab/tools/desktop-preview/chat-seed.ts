import type { ChatController } from '@gyblos/desktop/chat-controller';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import type { X402Result } from '@gyblos/desktop/x402-model';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

const AGE_DAYS: Record<number, number> = {
  0: 4,
  1: 1,
  3: 2,
  4: 3,
  5: 5,
  6: 8,
  7: 12,
  8: 20,
};
const SEED_INDEX = { PINNED: 0, UNREAD: 2 } as const;

export function previewChatSeed(seeded: readonly string[]) {
  return {
    ages: Object.fromEntries(
      seeded.map((id, index) => [id, AGE_DAYS[index] ?? 0]),
    ),
    pinned: seeded.filter((_, index) => index === SEED_INDEX.PINNED),
    unread: seeded.filter((_, index) => index === SEED_INDEX.UNREAD),
  };
}

export const sharedReviewFailure = {
  error: 'The buyer requires a spending review.',
  failureReason: BUYER_KEY_CODES.REVIEW,
} satisfies Pick<X402Result, 'error' | 'failureReason'>;

export function seedFailedTurn(
  chat: ChatController,
  model: Parameters<ChatController['startPaypal']>[1],
  sessionId: string,
  example: string | null,
) {
  if (
    example !== 'failed-turn' &&
    example !== 'declined-turn' &&
    example !== 'expired-quote' &&
    example !== 'paypal-turn'
  )
    return false;
  const id = 'interrupted-turn';
  const paypal = example === 'paypal-turn';
  const origin = chat.startPaypal(
    'How do I read a file in TypeScript?',
    { ...model, free: false },
    id,
    paypal ? undefined : sessionId,
    paypal ? PAYMENT_METHOD.PAYPAL : PAYMENT_METHOD.USDC,
  );
  if (origin) {
    if (example === 'failed-turn')
      chat.appendBuyer(
        origin,
        id,
        'Read the file with:\n\n```ts\nconst text =',
      );
    chat.setDraft('How should I handle an empty file?');
    if (!paypal)
      chat.failPaypal(
        origin,
        id,
        '',
        example === 'failed-turn'
          ? sharedReviewFailure.failureReason
          : example === 'expired-quote'
            ? PAID_EXECUTION_CODES.EXPIRED
            : SESSION_CODES.REQUEST_DECLINED,
      );
  }
  return true;
}

export function previewChatTitles(tenChats: boolean) {
  const titles = [
    'Product launch plan',
    'Explain vector search',
    'Research assistant',
  ];
  if (tenChats)
    titles.push(
      'Review API changes',
      'Plan the onboarding flow',
      'Compare model outputs',
      'Summarize meeting notes',
      'Explore search ranking',
      'Outline a release checklist',
    );
  return titles;
}
