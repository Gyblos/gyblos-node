// Parses operator settings for the loopback-only PayPal Sandbox prototype.
import { PAYPAL_SANDBOX } from './constants';

export function paypalSandboxSettings(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const portText =
    environment.PAYPAL_SANDBOX_PORT ?? String(PAYPAL_SANDBOX.port);
  const port = Number(portText);
  const ollamaOrigin =
    environment.PAYPAL_SANDBOX_OLLAMA_ORIGIN ?? PAYPAL_SANDBOX.ollamaOrigin;
  if (
    !/^\d+$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > PAYPAL_SANDBOX.maxPort ||
    !URL.canParse(ollamaOrigin)
  )
    throw new Error('Invalid sandbox configuration');
  const url = new URL(ollamaOrigin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid sandbox configuration');
  return { port, ollamaOrigin: url.href };
}
