// Runs a private buyer and presents its actual startup policy; never retries a sent prompt.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import { isMain } from '@gyblos/runtime';

import { startBuyer } from './buyer-main';
import {
  chatTurn,
  type ChatTurnOptions,
  type ChatTurnResult,
} from './chat-cli-turn';
import { isFreeAtomic, PAID_VERDICTS } from './constants';
import { startupMessage } from './free-main';

export interface ChatSessionOptions {
  model: string;
  maxTokens: number;
  maxAtomic: string;
  automatic?: boolean;
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
    automatic?: boolean;
    request: typeof fetch;
  };
  close(): Promise<void>;
  inspectAndClose?: PaymentInspector;
}>;
type PaymentInspector = (
  requestDigest: string,
  signal?: AbortSignal,
) => Promise<
  | {
      chargedAtomic: string;
      refundedAtomic: string;
    }
  | undefined
>;
export async function runTerminal(
  start: ChatStarter,
  inputStream: Readable,
  output: Writable,
  signal?: AbortSignal,
  inspect?: PaymentInspector,
) {
  if (signal?.aborted) return;
  const controller = new AbortController();
  const input = createInterface({ input: inputStream, output });
  const abort = () => {
    controller.abort();
    input.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  input.on('SIGINT', abort);
  try {
    await runOwnedChat(
      start,
      async () => {
        try {
          return await input.question('\nYou: ', { signal: controller.signal });
        } catch {
          return undefined;
        }
      },
      (text) => {
        output.write(text);
      },
      controller.signal,
      inspect,
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    input.close();
  }
}
export async function runOwnedChat(
  start: ChatStarter,
  read: () => Promise<string | undefined>,
  write: (text: string) => void,
  signal?: AbortSignal,
  inspect?: PaymentInspector,
) {
  const host = await start({ port: 0 });
  let digest: string | undefined;
  let observed: Awaited<ReturnType<PaymentInspector>>;
  let attempted = false;
  try {
    digest = await chatSession({ ...host.chat, read, write, signal });
  } finally {
    if (digest && host.inspectAndClose) {
      attempted = true;
      try {
        observed = await host.inspectAndClose(digest);
      } catch {
        observed = undefined;
      }
    } else await host.close();
  }
  if (digest && (attempted || inspect)) {
    try {
      const payment = attempted ? observed : await inspect?.(digest);
      if (payment) {
        write(
          `Configured RPC reports finalized charge ${payment.chargedAtomic}; refunded ${payment.refundedAtomic} atomic units. Check the journal with buyer:reconcile:paid before continuing.\n`,
        );
        return;
      }
    } catch {
      // The inspection is optional; a failure never changes the payment state.
    }
    write(
      'Payment is still pending or could not be verified. Reconcile before continuing.\n',
    );
  }
}
export async function chatSession(options: ChatSessionOptions) {
  const paid = !isFreeAtomic(options.maxAtomic);
  const mode = options.automatic
    ? paid
      ? 'automatic (free or paid by signed quote)'
      : 'automatic (free quotes only)'
    : paid
      ? 'paid (devnet)'
      : 'free';
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
      automatic: options.automatic,
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
    if (result.payment) {
      const { verdict, charged, refunded } = result.payment;
      options.write(
        verdict === PAID_VERDICTS.SETTLED
          ? `Payment: ${verdict}; charged: ${charged ?? 'unknown'}; refunded: ${refunded ?? 'unknown'} atomic units\n`
          : `Payment: ${verdict}; reported charge: ${charged ?? 'unknown'} atomic units (not confirmed)\n`,
      );
    }
    if (result.status === 'uncertain') {
      options.write(
        'The request may have been sent. No retry was made. Check the buyer and reconcile any uncertain payment before continuing.\n',
      );
      return paid && result.payment?.verdict !== PAID_VERDICTS.SETTLED
        ? result.requestDigest
        : undefined;
    }
  }
}
export async function main(options?: {
  start?: ChatStarter;
  buyerOptions?: Parameters<typeof startBuyer>[0];
  onStarted?: (
    host: Awaited<ReturnType<ChatStarter>>,
  ) => Awaited<ReturnType<ChatStarter>>;
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const start: ChatStarter = async ({ port }) => {
      const host = await (options?.start ?? startBuyer)({
        ...options?.buyerOptions,
        port,
      });
      try {
        return options?.onStarted?.(host) ?? host;
      } catch (error) {
        await host.close();
        throw error;
      }
    };
    await runTerminal(
      start,
      options?.input ?? stdin,
      options?.output ?? stdout,
      signal,
    );
  } catch (error) {
    console.error(startupMessage(error));
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
  }
}
if (isMain(import.meta.url)) await main();
