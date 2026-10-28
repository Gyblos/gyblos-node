// Reuses the mockup's compact Chat/Connect shell and palette for a compatibility view.
// Chat, gateway, wallets and network discovery remain disabled in this probe.
import { useEffect, useState } from 'react';

import { PROBE_STATUS } from './constants';
import { failedProbe, type ProbeResult, type ProbeStatus } from './probe-model';
import { themeStyle } from './theme';

import './renderer.css';

declare global {
  interface Window {
    desktopProbe: { run(): Promise<ProbeResult> };
  }
}
export function CompatibilityView() {
  const [light, setLight] = useState(false);
  const [status, setStatus] = useState<ProbeStatus>(PROBE_STATUS.WAITING);
  const [result, setResult] = useState<ProbeResult | null>(null);
  useEffect(() => {
    const apply = (value: ProbeResult) => {
      setResult(value);
      setStatus(value.status);
    };
    void window.desktopProbe
      .run()
      .then(apply)
      .catch(() => apply(failedProbe()));
  }, []);
  return (
    <div className="desktop-probe" style={themeStyle(light)}>
      <aside>
        <div className="modes">
          <button
            title="Chat preview"
            aria-label="Chat preview"
            aria-pressed="true"
          >
            ◯
          </button>
          <button
            title="Connect is outside this probe"
            aria-label="Connect is outside this probe"
            disabled
          >
            ⌘
          </button>
        </div>
        <span>Chat</span>
        <div className="sidebar-bottom">
          <button
            onClick={() => setLight(!light)}
            aria-label="Toggle light mode"
          >
            {light ? '☾' : '☀'}
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>Chat</span>
          <span className="badge">Compatibility probe</span>
        </header>
        <ProbePanel status={status} result={result} light={light} />
      </main>
      <footer>
        <span>
          {status === PROBE_STATUS.PASSED
            ? '● Local transport verified'
            : '○ Local compatibility check'}
        </span>
        <span>No external network · No payments</span>
        <span>Desktop probe</span>
      </footer>
    </div>
  );
}
function ProbePanel({
  status,
  result,
  light,
}: {
  status: ProbeStatus;
  result: ProbeResult | null;
  light: boolean;
}) {
  return (
    <section className="chat-panel">
      <div className="welcome">
        <img
          className="signature"
          alt="Gyblos"
          src={`./assets/gyblos-mark-solid-${light ? 'light' : 'dark'}.svg`}
        />
        <h1>Desktop foundation</h1>
        <p>Electron + the Gyblos node lifecycle + native Iroh</p>
        <div className="probe-result" role="status">
          <strong>
            {status === PROBE_STATUS.WAITING
              ? 'Checking local transport…'
              : status === PROBE_STATUS.PASSED
                ? 'Local Iroh check passed'
                : 'Local Iroh check failed'}
          </strong>
          <p>
            {result?.closed
              ? 'Two loopback round trips · two lifecycle cycles · endpoints closed'
              : 'No relay, wallet or payment is started.'}
          </p>
        </div>
        <div className="composer">
          <textarea
            disabled
            placeholder="Chat stays simulated in this compatibility probe"
            aria-label="Chat unavailable in compatibility probe"
          />
          <div>
            <span>Model selection and Connect follow in separate work.</span>
            <button disabled aria-label="Send unavailable">
              ↑
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
