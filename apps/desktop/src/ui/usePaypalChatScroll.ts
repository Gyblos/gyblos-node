// Keeps new PayPal chat messages in view without interrupting someone reading history.
// Scrolling changes only the local presentation; it never starts a paid request.
import { useLayoutEffect, useRef, useState } from 'react';

import { PaypalChatScroll, type PaypalChatController } from '../paypal-chat';

type Snapshot = ReturnType<PaypalChatController['getSnapshot']>;

export function usePaypalChatScroll(state: Snapshot, active: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const previousPending = useRef<string | null>(null);
  const [scroll] = useState(() => new PaypalChatScroll());
  const [nearBottom, setNearBottom] = useState(true);

  useLayoutEffect(() => {
    const submitted = previousPending.current === null && !!state.pendingPrompt;
    previousPending.current = state.pendingPrompt;
    const element = viewport.current;
    if (!active || !element) return;
    if (submitted) {
      scroll.latest(element);
      setNearBottom(true);
    } else scroll.follow(element);
  }, [active, scroll, state.messages, state.pendingPrompt]);

  function onScroll() {
    if (viewport.current) setNearBottom(scroll.observe(viewport.current));
  }
  function latest() {
    if (viewport.current) scroll.latest(viewport.current);
    setNearBottom(true);
  }
  return { viewport, nearBottom, onScroll, latest };
}
