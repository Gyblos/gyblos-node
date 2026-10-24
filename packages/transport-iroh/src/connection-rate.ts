// Bounds connection attempts before handshakes and authenticated peer churn after handshakes.
// Window debt survives connection release; maps cannot exceed the global attempt budget.
import { TRANSPORT_LIMITS } from '@gyblos/config';

export function createConnectionRate(now: () => number) {
  let started = now();
  let last = started;
  let attempts = 0;
  const sources = new Map<string, number>();
  const peers = new Map<string, number>();
  function refresh() {
    const time = now();
    if (
      !Number.isFinite(last) ||
      last < 0 ||
      !Number.isFinite(time) ||
      time < last ||
      time < 0
    )
      return false;
    last = time;
    if (time - started >= TRANSPORT_LIMITS.rateWindowMs) {
      started = time;
      attempts = 0;
      sources.clear();
      peers.clear();
    }
    return true;
  }
  return {
    attempt(source: string) {
      if (
        !refresh() ||
        attempts >= TRANSPORT_LIMITS.connectionAttemptsPerWindow
      )
        return false;
      attempts++;
      const count = sources.get(source) ?? 0;
      if (count >= TRANSPORT_LIMITS.connectionAttemptsPerSource) return false;
      sources.set(source, count + 1);
      return true;
    },
    peer(peer: string) {
      if (!refresh()) return false;
      const count = peers.get(peer) ?? 0;
      if (
        count >= TRANSPORT_LIMITS.connectionAttemptsPerPeer ||
        (!peers.has(peer) &&
          peers.size >= TRANSPORT_LIMITS.connectionAttemptsPerWindow)
      )
        return false;
      peers.set(peer, count + 1);
      return true;
    },
  };
}
