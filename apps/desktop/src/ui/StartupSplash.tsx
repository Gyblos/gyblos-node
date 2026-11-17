// Shows completed local startup milestones; never reads secrets or starts a connection.
import { useEffect, useState } from 'react';

import { STARTUP_PROGRESS, STARTUP_WINDOW } from '../constants';
import {
  observeStartupProgress,
  type StartupProgressBridge,
} from '../startup-progress';
import { prefersLightTheme, themeStyle } from '../theme';

declare global {
  interface Window {
    desktopStartup?: StartupProgressBridge;
  }
}

export function StartupSplash() {
  const light = prefersLightTheme();
  const [percentage, setPercentage] = useState<number>(STARTUP_PROGRESS.MIN);
  useEffect(() => {
    const bridge = window.desktopStartup;
    if (bridge) return observeStartupProgress(bridge, setPercentage);
  }, []);
  return (
    <main className="startup-splash" style={themeStyle(light)}>
      <div className="startup-splash-brand">
        <img
          src={`./assets/startup-mark-${light ? 'light' : 'dark'}.svg`}
          width={32}
          height={32}
          alt=""
        />{' '}
        Gyblos
      </div>
      <div
        className="startup-ascii"
        role="progressbar"
        aria-label="Application startup"
        aria-valuemin={STARTUP_PROGRESS.MIN}
        aria-valuemax={STARTUP_PROGRESS.MAX}
        aria-valuenow={percentage}
      >
        <span aria-hidden="true">[</span>
        <span className="startup-ascii-cells" aria-hidden="true">
          <AsciiBars />
          <AsciiBars filled percentage={percentage} />
        </span>
        <span aria-hidden="true">]</span>
      </div>
      <p role="status">Preparing your app… {percentage}%</p>
    </main>
  );
}

function AsciiBars({
  filled = false,
  percentage = STARTUP_PROGRESS.MIN,
}: {
  filled?: boolean;
  percentage?: number;
}) {
  return (
    <span
      className={`startup-ascii-row${filled ? ' is-filled' : ''}`}
      style={
        filled
          ? {
              clipPath: `inset(0 ${STARTUP_PROGRESS.MAX - percentage}% 0 0)`,
            }
          : undefined
      }
    >
      {Array.from({ length: STARTUP_WINDOW.BARS }, (_, index) => (
        <span className="startup-ascii-bar" key={index}>
          |
        </span>
      ))}
    </span>
  );
}
