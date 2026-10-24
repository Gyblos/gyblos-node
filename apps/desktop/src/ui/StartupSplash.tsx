// Shows a visual-only startup indicator; never reads wallet metadata or starts a connection.
import { STARTUP_WINDOW } from '../constants.js';
import { themeStyle } from '../theme.js';

export function StartupSplash() {
  return (
    <main className="startup-splash" style={themeStyle(false)}>
      <div className="startup-splash-brand">
        <span>[g]</span> Gyblos
      </div>
      <div className="startup-ascii" aria-hidden="true">
        <span>[</span>
        {Array.from({ length: STARTUP_WINDOW.BARS }, (_, index) => (
          <span
            className="startup-ascii-bar"
            key={index}
            style={{
              animationDelay: `${-index * STARTUP_WINDOW.BAR_PHASE_MS}ms`,
            }}
          >
            |
          </span>
        ))}
        <span>]</span>
      </div>
      <p role="status">Preparing your app…</p>
      <small>Network preview is simulated.</small>
    </main>
  );
}
