// The desktop uses the terminal mark approved in the preview in both themes.
import { SIGNAL_STATE, type SignalState } from './constants';

export { SIGNAL_STATE } from './constants';
export function SignalMark({
  state = SIGNAL_STATE.IDLE,
}: {
  state?: SignalState;
}) {
  return (
    <span aria-hidden="true" className="signal-mark" data-expression={state}>
      <img
        className="signal-dark"
        src="./assets/startup-mark-dark.svg"
        alt=""
      />
      <img
        className="signal-light"
        src="./assets/startup-mark-light.svg"
        alt=""
      />
    </span>
  );
}
export function SignalTrace({ model }: { model: string }) {
  return (
    <pre className="signal-trace" aria-label="Provider route">
      {`[you] ── Gyblos ── [${model}]`}
    </pre>
  );
}
