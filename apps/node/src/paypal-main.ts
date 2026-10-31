// Starts a local-only PayPal Sandbox demo with the pinned Gyblos Ollama engine and private journal.
import { isAbsolute } from 'node:path';

import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import { createPaypalSandbox } from '@gyblos/payments-paypal';
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
  const engine = createOllamaEngine('http://127.0.0.1:11434/');
  await engine.describe();
  const journal = await openPaypalJournal(stateDirectory);
  let demo: Awaited<ReturnType<typeof startPaypalDemo>> | undefined;
  let shutdown: ReturnType<typeof shutdownSignal> | undefined;
  try {
    demo = await startPaypalDemo({
      port: 8765,
      engine,
      journal,
      payment: createPaypalSandbox({ clientId, clientSecret }),
    });
    process.stdout.write(`PayPal Sandbox demo: ${demo.url}\n`);
    shutdown = shutdownSignal();
    await shutdown.signalled;
  } finally {
    try {
      await demo?.close();
    } finally {
      await journal.close();
      shutdown?.dispose();
    }
  }
}

if (isMain(import.meta.url)) await main();
