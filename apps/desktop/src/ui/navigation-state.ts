// Keeps contextual buyer journeys separate from primary sidebar destinations.
// This state never affects chat, payment operations or browser history.
import { UI_VIEW } from './constants';
import type { View } from './model-types';

export { UI_VIEW } from './constants';

type Navigation = { current: View; history: View[] };
export function createNavigation(): Navigation {
  return { current: UI_VIEW.CHAT, history: [] };
}
export function navigate(
  state: Navigation,
  next: View,
  contextual = true,
): Navigation {
  if (!contextual) return { current: next, history: [] };
  if (state.current === next) return state;
  const previous = state.history.indexOf(next);
  return {
    current: next,
    history:
      previous < 0
        ? [...state.history, state.current]
        : state.history.slice(0, previous),
  };
}
export function back(state: Navigation): Navigation {
  const previous = state.history.at(-1);
  return previous
    ? { current: previous, history: state.history.slice(0, -1) }
    : state;
}
