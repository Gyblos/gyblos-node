// Shared light/dark switch for the navigation rail and Settings.
// Changes local preview appearance only; no preferences are persisted.
import { Moon, Sun } from '@phosphor-icons/react';

import { Button } from './UI.js';

export function Appearance({
  light,
  onLightChange,
  compact = false,
}: {
  light: boolean;
  onLightChange: (light: boolean) => void;
  compact?: boolean;
}) {
  const control = (
    <Button
      className="theme-switch"
      role="switch"
      aria-checked={light}
      aria-label="Light mode"
      title={light ? 'Switch to dark mode' : 'Switch to light mode'}
      onClick={() => onLightChange(!light)}
    >
      <span className="theme-switch-thumb" aria-hidden="true" />
      <Moon size={14} aria-hidden="true" />
      <Sun size={14} aria-hidden="true" />
    </Button>
  );
  return compact ? (
    control
  ) : (
    <div className="appearance-mode">
      <span>
        Appearance <small>{light ? 'Light' : 'Dark'}</small>
      </span>
      {control}
    </div>
  );
}
