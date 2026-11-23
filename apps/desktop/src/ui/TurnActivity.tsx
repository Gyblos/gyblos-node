import { CaretRight } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { RESPONSE_METRICS } from '../constants';
import {
  MESSAGE_STATE,
  type MessageState,
  type TurnTiming,
} from './chat-state';
import { TURN_ACTIVITY } from './constants';

export function TurnActivity({
  timing,
  state,
  hasText,
}: {
  timing: TurnTiming;
  state: MessageState;
  hasText: boolean;
}) {
  const waiting = state === MESSAGE_STATE.PENDING && !hasText;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const start = timing.started;
    const timer = window.setInterval(
      () => setElapsed(performance.now() - start),
      TURN_ACTIVITY.TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [waiting, timing]);
  const seconds = (ms: number) =>
    (ms / RESPONSE_METRICS.MS_PER_SECOND).toFixed(1) + ' s';
  const outcome =
    state === MESSAGE_STATE.COMPLETE
      ? 'Response complete'
      : state === MESSAGE_STATE.STOPPED
        ? 'Stopped'
        : state === MESSAGE_STATE.FAILED
          ? 'Response unavailable'
          : null;
  return (
    <div className="turn-signal">
      <details>
        <summary>
          <CaretRight size={13} aria-hidden="true" />
          Activity
        </summary>
        <ol>
          <li>Request started locally</li>
          {timing.first !== undefined && (
            <li>
              First text received{' '}
              <time>{seconds(timing.first - timing.started)}</time>
            </li>
          )}
          {outcome && (
            <li>
              {outcome}{' '}
              {timing.ended !== undefined && (
                <time>{seconds(timing.ended - timing.started)}</time>
              )}
            </li>
          )}
        </ol>
      </details>
      {waiting && elapsed >= TURN_ACTIVITY.REVEAL_MS && (
        <div className="turn-wait">
          <span className="turn-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span role="status">Waiting for response</span>
          {elapsed >= TURN_ACTIVITY.SHOW_CLOCK_MS && (
            <time aria-hidden="true">{seconds(elapsed)}</time>
          )}
        </div>
      )}
    </div>
  );
}
