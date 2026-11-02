// Interactive presentation of the existing local buyer endpoint; it never starts a buyer or retries.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { rolePathIn } from '@gyblos/config/home';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';
import { readPrivateFile } from '@gyblos/runtime/private-file';

import {
  chatTurn,
  type ChatTurnOptions,
  type ChatTurnResult,
} from './chat-cli-turn';
import { PAID_BUYER } from './constants';
import { loadBuyerSelectionConfig } from './selection-config';

export interface ChatSessionOptions {
  model: string;
  maxTokens: number;
  maxAtomic: string;
  token?: string;
  read: () => Promise<string | undefined>;
  write: (text: string) => void;
  signal?: AbortSignal;
  turn?: (options: ChatTurnOptions) => Promise<ChatTurnResult>;
}
export async function chatSession(options: ChatSessionOptions) {
  const mode = options.token ? 'paid (devnet)' : 'free';
  options.write(
    `Model: ${options.model}\nMode: ${mode}\nMaximum deposit: ${options.maxAtomic} atomic units per request\nType /exit to quit. Each question is independent.\n`,
  );
  while (!options.signal?.aborted) {
    const prompt = await options.read();
    if (prompt === undefined || prompt.trim() === '/exit') return;
    const result = await (options.turn ?? chatTurn)({
      model: options.model,
      maxTokens: options.maxTokens,
      prompt,
      token: options.token,
      write: options.write,
      signal: options.signal,
    });
    if (result.status === 'rejected') {
      options.write('\nQuestion rejected before sending.\n');
      continue;
    }
    options.write('\n');
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
  try {
    const config = await loadBuyerSelectionConfig(process.env);
    if (!config) throw new Error('configuration');
    const paid = config.request.maxAtomic !== '0';
    let token: string | undefined;
    if (paid) {
      const value = await readPrivateFile(
        rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
        PAID_BUYER.tokenFileBytes,
      );
      token = value?.trimEnd();
      if (
        !token ||
        !new RegExp(`^[A-Za-z0-9_-]{${PAID_BUYER.tokenChars}}$`).test(token)
      )
        throw new Error('token');
    }
    const controller = new AbortController();
    const input = createInterface({ input: stdin, output: stdout });
    const cancel = () => {
      controller.abort();
      input.close();
    };
    input.on('SIGINT', cancel);
    process.once('SIGINT', cancel);
    try {
      await chatSession({
        model: config.request.selection.modelId,
        maxTokens: config.request.maxTokens,
        maxAtomic: config.request.maxAtomic,
        token,
        signal: controller.signal,
        read: async () => {
          try {
            return await input.question('\nYou: ', {
              signal: controller.signal,
            });
          } catch {
            return undefined;
          }
        },
        write: (text) => {
          stdout.write(text);
        },
      });
    } finally {
      process.off('SIGINT', cancel);
      input.close();
    }
  } catch {
    console.error(
      'Buyer configuration or private token unavailable. Configure and start pnpm buyer first; see docs/running-a-node.md.',
    );
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
