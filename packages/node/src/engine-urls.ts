// Where a provider API plugin may send requests: https on any host, or plain http to a literal loopback
// server on this machine. Names such as localhost or host.docker.internal wait for gyblos init, and a
// query or fragment (even an empty one) would replace the base's path when routes join it.
import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';

const LOOPBACK_HOSTS: readonly string[] = [LOCALHOST, IPV6_LOOPBACK];

export function isLocalEngineUrl(url: URL) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
}

export function providerEngineUrl(raw: string) {
  if (!URL.canParse(raw) || /[?#]/.test(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === 'https:' || isLocalEngineUrl(url) ? url : undefined;
}
