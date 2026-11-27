import { CHAT_FAILURE } from '@gyblos/desktop/chat-archive-model';
import type { ChatController } from '@gyblos/desktop/chat-controller';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import type { X402Result } from '@gyblos/desktop/x402-model';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { PREVIEW_FAILURE } from './constants';

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
  const freeLimit =
    example === PREVIEW_FAILURE.PARTIAL_LIMIT ||
    example === PREVIEW_FAILURE.EMPTY_LIMIT;
  const failures = new Map<string, X402Result['failureReason']>([
    [PREVIEW_FAILURE.INTERRUPTED, undefined],
    [PREVIEW_FAILURE.PAYPAL, undefined],
    [PREVIEW_FAILURE.PAYPAL_PROMPT, CHAT_FAILURE.PAYPAL_PROMPT_INVALID],
    [PREVIEW_FAILURE.CLOSED, SESSION_CODES.CLOSED],
    [PREVIEW_FAILURE.BINDING, SESSION_CODES.BINDING],
    [PREVIEW_FAILURE.PARTIAL_LIMIT, CHAT_FAILURE.FREE_LIMIT],
    [PREVIEW_FAILURE.EMPTY_LIMIT, CHAT_FAILURE.FREE_LIMIT],
    [PREVIEW_FAILURE.SHARED_UNSENT, CHAT_FAILURE.KEY_REVIEW_NOT_SENT],
    [PREVIEW_FAILURE.SHARED, sharedReviewFailure.failureReason],
    [PREVIEW_FAILURE.EXPIRED, PAID_EXECUTION_CODES.EXPIRED],
    [PREVIEW_FAILURE.DECLINED, SESSION_CODES.REQUEST_DECLINED],
    [PREVIEW_FAILURE.STOP, SESSION_CODES.REQUEST_DECLINED],
  ]);
  if (!example || !failures.has(example)) return false;
  const id = 'interrupted-turn';
  const paypal =
    example === PREVIEW_FAILURE.PAYPAL ||
    example === PREVIEW_FAILURE.PAYPAL_PROMPT;
  const origin = chat.startPaypal(
    'How do I read a file in TypeScript?',
    { ...model, free: freeLimit },
    id,
    paypal ? undefined : sessionId,
    paypal ? PAYMENT_METHOD.PAYPAL : PAYMENT_METHOD.USDC,
  );
  if (origin) {
    if (
      example === PREVIEW_FAILURE.SHARED ||
      example === PREVIEW_FAILURE.PARTIAL_LIMIT
    )
      chat.appendBuyer(
        origin,
        id,
        'Read the file with:\n\n```ts\nconst text =',
      );
    chat.setDraft('How should I handle an empty file?');
    const failure = failures.get(example);
    if (failure) chat.failPaypal(origin, id, '', failure);
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
