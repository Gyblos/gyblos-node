// Owns the network selector in the header: devnet is the only network with data; mainnet is listed but
// not selectable until it launches. A native select keeps it accessible with no client code.
import { NETWORKS } from '../lib/config';

export function NetworkSelect() {
  return (
    <label className="relative">
      <span className="sr-only">Network</span>
      <select
        defaultValue={NETWORKS[0].id}
        className="appearance-none rounded-full border border-line bg-bg py-1 pr-8 pl-3 font-mono text-xs text-muted hover:border-dim focus:border-brand focus:outline-none"
      >
        {NETWORKS.map((network) => (
          <option key={network.id} value={network.id} disabled={!network.live}>
            {network.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[10px] text-dim"
      >
        ▾
      </span>
    </label>
  );
}
