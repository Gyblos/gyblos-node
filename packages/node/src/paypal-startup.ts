// Composes sandbox payment and Ollama adapters for the local one-seller prototype.
import { createOllamaAgent } from '@gyblos/engine-ollama/agent';
import { GENERATION, MODEL } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { renderChat } from '@gyblos/engine-ollama/model';
import { createPaypalSandbox } from '@gyblos/payments-paypal';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { openPaypalJournal } from './paypal-journal';

export function validatePaypalPrompt(prompt: string, maxTokens: number) {
  let rendered: string;
  try {
    rendered = renderChat(prompt);
  } catch {
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  }
  if (Buffer.byteLength(rendered, 'utf8') + maxTokens > GENERATION.numCtx)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}

export async function openPaypalSandbox(options: {
  clientId: string;
  clientSecret: string;
  stateDirectory: string;
  returnOrigin: string;
  ollamaOrigin: string;
  agentModel?: string;
  deferEngineCheck?: boolean;
}) {
  const engine = createOllamaEngine(options.ollamaOrigin);
  const agentEngine = createOllamaAgent(options.ollamaOrigin, fetch, {
    model: options.agentModel,
  });
  if (!options.deferEngineCheck) await engine.describe();
  const payment = createPaypalSandbox(options);
  const journal = await openPaypalJournal(options.stateDirectory);
  return {
    engine,
    agentEngine,
    model: MODEL.name,
    payment,
    journal,
    validateRequest: validatePaypalPrompt,
    close: () => journal.close(),
  };
}
