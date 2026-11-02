// Runs a private buyer and presents its actual startup policy; never retries a sent prompt.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { isMain } from '@gyblos/runtime';

import { startBuyer } from './buyer-main';
import {
  chatTurn,
  type ChatTurnOptions,
  type ChatTurnResult,
} from './chat-cli-turn';
import { isFreeAtomic } from './constants';

export interface ChatSessionOptions {
  model: string;
  maxTokens: number;
  maxAtomic: string;
  request: typeof fetch;
  read: () => Promise<string | undefined>;
  write: (text: string) => void;
  signal?: AbortSignal;
  turn?: (options: ChatTurnOptions) => Promise<ChatTurnResult>;
}
type ChatStarter = (options: { port: number }) => Promise<{
  chat: {
    model: string;
    maxTokens: number;
    maxAtomic: string;
    request: typeof fetch;
  };
  close(): Promise<void>;
}>;
export async function runOwnedChat(
  start: ChatStarter,
  read: () => Promise<string | undefined>,
  write: (text: string) => void,
  signal?: AbortSignal,
) {
  const host = await start({ port: 0 });
  try {
    await chatSession({ ...host.chat, read, write, signal });
  } finally {
    await host.close();
  }
}
export async function chatSession(options: ChatSessionOptions) {
  const paid = !isFreeAtomic(options.maxAtomic);
  const mode = paid ? 'paid (devnet)' : 'free';
  options.write(
    `Model: ${options.model}\nMode: ${mode}\nMaximum deposit: ${options.maxAtomic} atomic units per request\nType /exit to quit. Each question is independent.\n`,
  );
  while (!options.signal?.aborted) {
    const prompt = await options.read();
    if (prompt === undefined || prompt.trim() === '/exit') return;
    const input = {
      model: options.model,
      maxTokens: options.maxTokens,
      prompt,
      paid,
      write: options.write,
      signal: options.signal,
    };
    const result = await (options.turn
      ? options.turn(input)
      : chatTurn(input, options.request));
    if (result.status === 'rejected') {
      options.write('\nQuestion rejected before sending.\n');
      continue;
    }
    options.write('\n');
    if (result.code) options.write(`Error: ${result.code}\n`);
    if (result.usage)
      options.write(
        `Tokens: ${result.usage.input} input, ${result.usage.output} output\n`,
      );
    if (result.payment)
      options.write(
        `Payment: ${result.payment.verdict}; charged: ${result.payment.charged ?? 'unknown'}; refunded: ${result.payment.refunded ?? 'unknown'} atomic units\n`,
      );
    if (result.status === 'uncertain') {
      options.write(
        'The request may have been sent. No retry was made. Check the buyer and reconcile any uncertain payment before continuing.\n',
      );
      return;
    }
  }
}
export async function main() {
  const controller = new AbortController();
  const input = createInterface({ input: stdin, output: stdout });
  const cancel = () => {
    controller.abort();
    input.close();
  };
  input.on('SIGINT', cancel);
  process.once('SIGINT', cancel);
  try {
    await runOwnedChat(
      startBuyer,
      async () => {
        try {
          return await input.question('\nYou: ', { signal: controller.signal });
        } catch {
          return undefined;
        }
      },
      (text) => {
        stdout.write(text);
      },
      controller.signal,
    );
  } catch {
    console.error(
      'Could not start the buyer. Check its configuration and ensure another buyer is not running; see docs/running-a-node.md.',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    input.close();
  }
}
if (isMain(import.meta.url)) await main();
