// Keeps chronological screen visits for both sidebar and contextual navigation.
// This state never affects chat, payment operations or browser history.
import { UI_VIEW } from './constants';
import type { View } from './model-types';

export { UI_VIEW } from './constants';

export type Navigation = { current: View; history: View[]; future: View[] };
export function createNavigation(): Navigation {
  return { current: UI_VIEW.CHAT, history: [], future: [] };
}
export function navigate(state: Navigation, next: View): Navigation {
  if (state.current === next) return state;
  return {
    current: next,
    history: [...state.history, state.current],
    future: [],
  };
}
export function back(state: Navigation): Navigation {
  const previous = state.history.at(-1);
  return previous
    ? {
        current: previous,
        history: state.history.slice(0, -1),
        future: [state.current, ...state.future],
      }
    : state;
}

export function forward(state: Navigation): Navigation {
  const next = state.future[0];
  return next
    ? {
        current: next,
        history: [...state.history, state.current],
        future: state.future.slice(1),
      }
    : state;
}
