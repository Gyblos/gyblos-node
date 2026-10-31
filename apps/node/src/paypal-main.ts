// Starts a local-only PayPal Sandbox demo with the pinned Gyblos Ollama engine and private journal.
import { isAbsolute } from 'node:path';

import { paypalSandboxSettings } from '@gyblos/config/paypal';
import { openPaypalSandbox } from '@gyblos/node/paypal-startup';
import { isMain, shutdownSignal } from '@gyblos/runtime';

import { startPaypalDemo } from './paypal-demo';

export async function main() {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  const stateDirectory = process.env.PAYPAL_SANDBOX_STATE_DIRECTORY;
  if (
    !clientId ||
    !clientSecret ||
    !stateDirectory ||
    !isAbsolute(stateDirectory)
  )
    throw new Error(
      'Set sandbox credentials and an absolute dedicated sandbox state directory.',
    );
  const settings = paypalSandboxSettings(process.env);
  const sandbox = await openPaypalSandbox({
    clientId,
    clientSecret,
    stateDirectory,
    returnOrigin: `http://127.0.0.1:${settings.port}`,
    ollamaOrigin: settings.ollamaOrigin,
  });
  let demo: Awaited<ReturnType<typeof startPaypalDemo>> | undefined;
  let shutdown: ReturnType<typeof shutdownSignal> | undefined;
  try {
    demo = await startPaypalDemo({
      port: settings.port,
      ...sandbox,
    });
    process.stdout.write(
      `PayPal Sandbox demo (private session link): ${demo.accessUrl}\n`,
    );
    shutdown = shutdownSignal();
    await shutdown.signalled;
  } finally {
    try {
      await demo?.close();
    } finally {
      await sandbox.close();
      shutdown?.dispose();
    }
  }
}

if (isMain(import.meta.url)) await main();
