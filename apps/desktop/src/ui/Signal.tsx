// Gyblos's original vector letter transitions into an expressive task signal.
// Decorative state only: never claims a real provider connection or changes chat execution.
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

import { SIGNAL_STATE, SIGNATURE_GEOMETRY } from './constants';

type SignatureStyle = CSSProperties & { [key: `--signal-${string}`]: string };
const GEOMETRY_STYLE: SignatureStyle = Object.fromEntries(
  Object.entries(SIGNATURE_GEOMETRY).map(([name, value]) => [
    `--signal-${name}`,
    `path('${value}')`,
  ]),
);

export { SIGNAL_STATE } from './constants';

type SignalState = (typeof SIGNAL_STATE)[keyof typeof SIGNAL_STATE];
const SETTLE_MS = 1800;
// Preserve the shared square and continuous opposing travel from the original motion.
const ORBIT_PATH =
  'M 32 7 H 46 Q 50 7 50 11 V 37 Q 50 41 46 41 H 18 Q 14 41 14 37 V 11 Q 14 7 18 7 Z';
function transient(state: SignalState) {
  return state === SIGNAL_STATE.COMPLETE || state === SIGNAL_STATE.STOPPED;
}

export function SignalMark({
  state = SIGNAL_STATE.IDLE,
}: {
  state?: SignalState;
}) {
  const instanceId = useId().replace(/:/g, '');
  const gradientId = `signal-foil-${instanceId}`;
  const previous = useRef(state);
  const activated = useRef(false);
  const [expression, setExpression] = useState<SignalState>(SIGNAL_STATE.IDLE);
  useEffect(() => {
    // Opening an old transcript must not replay completion animations.
    if (previous.current === state && transient(state)) return;
    previous.current = state;
    if (
      !activated.current &&
      !transient(state) &&
      state !== SIGNAL_STATE.IDLE
    ) {
      // Commit the letter for one painted frame before morphing a new response mark.
      let secondFrame = 0;
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          activated.current = true;
          setExpression(state);
        });
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        window.cancelAnimationFrame(secondFrame);
      };
    }
    activated.current = true;
    setExpression(state);
    if (!transient(state)) return;
    const timer = window.setTimeout(
      () => setExpression(SIGNAL_STATE.IDLE),
      SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);
  const face = expression !== SIGNAL_STATE.IDLE;
  const working =
    expression === SIGNAL_STATE.CONNECTING ||
    expression === SIGNAL_STATE.WORKING ||
    expression === SIGNAL_STATE.RESPONDING;
  return (
    <svg
      className="signal-mark"
      viewBox="0 0 64 48"
      style={GEOMETRY_STYLE}
      data-expression={expression}
      data-face={face}
      data-working={working}
      aria-hidden="true"
      focusable="false"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop className="signal-foil-stop" offset="0%" />
          <stop className="signal-foil-stop" offset="35%" />
          <stop className="signal-foil-stop" offset="70%" />
          <stop className="signal-foil-stop" offset="100%" />
        </linearGradient>
        {(['left', 'right'] as const).map((strand) => (
          <linearGradient
            key={strand}
            id={`${gradientId}-${strand}`}
            gradientUnits="userSpaceOnUse"
            x1="14"
            y1="7"
            x2="50"
            y2="41"
          >
            <stop
              className={`signal-trail-stop signal-trail-stop--${strand}`}
              offset="0%"
            />
            <stop
              className={`signal-trail-stop signal-trail-stop--${strand}`}
              offset="45%"
            />
            <stop
              className={`signal-trail-stop signal-trail-stop--${strand}`}
              offset="100%"
            />
          </linearGradient>
        ))}
      </defs>
      <g
        className="signal-brackets"
        stroke={working ? `url(#${gradientId})` : 'var(--blue)'}
        strokeWidth="2.5"
      >
        <path
          className="signal-bracket signal-bracket-left"
          d="M 16 9 H 10 V 39 H 16"
        />
        <path
          className="signal-bracket signal-bracket-right"
          d="M 48 9 H 54 V 39 H 48"
        />
        <path
          className="signal-orbit signal-orbit-left"
          d={ORBIT_PATH}
          stroke={`url(#${gradientId}-left)`}
          pathLength="100"
        />
        <path
          className="signal-orbit signal-orbit-right"
          d={ORBIT_PATH}
          stroke={`url(#${gradientId}-right)`}
          pathLength="100"
        />
      </g>
      <g fill="var(--ink)" stroke="none" fillRule="evenodd">
        <path className="signal-eyes" d={SIGNATURE_GEOMETRY.letter} />
        <path className="signal-mouth" d={SIGNATURE_GEOMETRY.mouthOrigin} />
      </g>
    </svg>
  );
}
export function SignalTrace({ model }: { model: string }) {
  return (
    <pre className="signal-trace" aria-label="Provider route">
      {`[you] ── [g] ── [${model}]`}
    </pre>
  );
}
