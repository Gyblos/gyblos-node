// Coordinates short, reversible UI transitions in the isolated desktop concept.
// Retains closing surfaces briefly without changing their actions or persisting state.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import {
  MOTION_CLEANUP_MS,
  MOTION_VARIANT,
  SLIDE_DIRECTION,
  SLIDE_SURFACE,
} from './constants';

export { SLIDE_DIRECTION, SLIDE_SURFACE } from './constants';

type SlideDirection = (typeof SLIDE_DIRECTION)[keyof typeof SLIDE_DIRECTION];
type SlideSurface = (typeof SLIDE_SURFACE)[keyof typeof SLIDE_SURFACE];

const PANEL_SLIDE_MS = 300;
const EXIT_MS = PANEL_SLIDE_MS;
const ExitContext = createContext(false);

export function useExiting() {
  return useContext(ExitContext);
}

export function MotionPresence({
  children,
  variant = MOTION_VARIANT.SLIDE,
}: {
  children: ReactNode;
  variant?: (typeof MOTION_VARIANT)[keyof typeof MOTION_VARIANT];
}) {
  const present = Boolean(children);
  const exitMs = variant === MOTION_VARIANT.SLIDE ? PANEL_SLIDE_MS : EXIT_MS;
  const [retained, setRetained] = useState(present);
  const previous = useRef(children);

  useLayoutEffect(() => {
    if (present) {
      previous.current = children;
      setRetained(true);
      return;
    }
    if (!retained) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetained(false);
      return;
    }
    const timer = window.setTimeout(() => setRetained(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [children, present, retained, exitMs]);

  if (!present && !retained) return null;
  const timing: CSSProperties & {
    '--motion-exit': string;
    '--motion-panel': string;
  } = {
    '--motion-exit': `${exitMs}ms`,
    '--motion-panel': `${PANEL_SLIDE_MS}ms`,
  };
  return (
    <ExitContext.Provider value={!present}>
      <div
        className={`motion-presence${variant === MOTION_VARIANT.EXPAND ? ' motion-expand' : ''}`}
        data-motion={present ? 'enter' : 'exit'}
        data-motion-style={variant}
        style={timing}
        inert={!present}
      >
        {variant === MOTION_VARIANT.EXPAND ? (
          <div className="motion-expand-clip">
            {present ? children : previous.current}
          </div>
        ) : present ? (
          children
        ) : (
          previous.current
        )}
      </div>
    </ExitContext.Provider>
  );
}

// A non-interactive visual copy keeps React state and focus in the live pane.
function snapshotPane(pane: HTMLElement) {
  const snapshot = pane.cloneNode(true) as HTMLElement;
  const sourceElements = [pane, ...pane.querySelectorAll<HTMLElement>('*')];
  const copiedElements = [
    snapshot,
    ...snapshot.querySelectorAll<HTMLElement>('*'),
  ];
  const scrollPositions = sourceElements.map((element) => ({
    top: element.scrollTop,
    left: element.scrollLeft,
  }));
  copiedElements.forEach((element, index) => {
    element.removeAttribute('id');
    const source = sourceElements[index];
    if (
      source instanceof HTMLTextAreaElement &&
      element instanceof HTMLTextAreaElement
    ) {
      element.value = source.value;
    } else if (
      source instanceof HTMLInputElement &&
      element instanceof HTMLInputElement
    ) {
      element.value = source.value;
      element.checked = source.checked;
    }
  });
  return {
    element: snapshot,
    restoreScroll() {
      copiedElements.forEach((element, index) => {
        const position = scrollPositions[index];
        if (!position) return;
        element.scrollTop = position.top;
        element.scrollLeft = position.left;
      });
    },
  };
}

function pushWithoutNative(
  update: () => void,
  selector: string,
  direction: SlideDirection,
) {
  document.querySelectorAll('.slide-stage').forEach((stage) => stage.remove());
  const pane = document.querySelector<HTMLElement>(selector);
  if (!pane) {
    update();
    return;
  }
  const bounds = pane.getBoundingClientRect();
  const outgoing = snapshotPane(pane);
  flushSync(update);
  const nextPane = document.querySelector<HTMLElement>(selector);
  if (!nextPane) return;
  const incoming = snapshotPane(nextPane);
  const stage = document.createElement('div');
  stage.className = 'slide-stage';
  stage.inert = true;
  stage.setAttribute('aria-hidden', 'true');
  stage.dataset.slideDirection = direction;
  Object.assign(stage.style, {
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
  outgoing.element.classList.add('slide-snapshot', 'slide-snapshot--out');
  incoming.element.classList.add('slide-snapshot', 'slide-snapshot--in');
  stage.append(outgoing.element, incoming.element);
  nextPane.after(stage);
  outgoing.restoreScroll();
  incoming.restoreScroll();
  const remove = () => stage.remove();
  incoming.element.addEventListener('animationend', remove, { once: true });
  // A suspended window or cancelled CSS animation must not retain stale content.
  window.setTimeout(remove, MOTION_CLEANUP_MS);
}

export function animateChange(
  update: () => void,
  direction: SlideDirection,
  surface: SlideSurface,
) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || document.querySelector('dialog[open]')) {
    update();
    return;
  }
  if (!document.startViewTransition) {
    pushWithoutNative(
      update,
      surface === SLIDE_SURFACE.WORKSPACE ? '.content' : '#output-content',
      direction,
    );
    return;
  }
  // Only the changing pane is captured; navigation and toolbars stay anchored.
  document.documentElement.dataset.slideDirection = direction;
  document.documentElement.dataset.slideSurface = surface;
  const transition = document.startViewTransition(() => flushSync(update));
  // Rapid navigation can cancel a snapshot; the state update still completes.
  void transition.ready.catch(() => undefined);
}
