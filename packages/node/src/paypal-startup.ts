// Composes sandbox payment and Ollama adapters for the local one-seller prototype.
import { GENERATION } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { renderChat } from '@gyblos/engine-ollama/model';
import { createPaypalSandbox } from '@gyblos/payments-paypal';

import { openPaypalJournal } from './paypal-journal';

export async function openPaypalSandbox(options: {
  clientId: string;
  clientSecret: string;
  stateDirectory: string;
  returnOrigin: string;
  ollamaOrigin: string;
}) {
  const engine = createOllamaEngine(options.ollamaOrigin);
  await engine.describe();
  const payment = createPaypalSandbox(options);
  const journal = await openPaypalJournal(options.stateDirectory);
  return {
    engine,
    payment,
    journal,
    validateRequest(prompt: string, maxTokens: number) {
      const rendered = renderChat(prompt);
      if (Buffer.byteLength(rendered, 'utf8') + maxTokens > GENERATION.numCtx)
        throw new Error('Prompt exceeds the model context');
    },
    close: () => journal.close(),
  };
}
