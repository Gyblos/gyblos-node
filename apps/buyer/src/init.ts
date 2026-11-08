// Guided terminal entry for shared buyer initialization; no discovery query, inference or payment.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { DEVNET_USDC } from '@gyblos/config';
import {
  buildBuyerInit,
  buyerInitDefaults,
  BuyerInitError,
  initializeBuyer,
  type BuyerInitAnswers,
} from '@gyblos/node/buyer-init';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { BUYER_INIT_INPUT } from './constants';

export interface BuyerInitTerminal {
  read(question: string): Promise<string | undefined>;
  write(text: string): void;
  initialize(input: BuyerInitAnswers): Promise<unknown>;
}
const FIELDS: readonly {
  key: keyof BuyerInitAnswers;
  label: string;
  clearable?: boolean;
}[] = [
  {
    key: 'sellerNodeId',
    label: 'Seller NodeId (from an independent trusted source)',
  },
  {
    key: 'sellerOwner',
    label: 'Seller owner wallet (verified against 8004 at runtime)',
  },
  { key: 'modelId', label: 'Model ID (exact catalog value)' },
  {
    key: 'variant',
    label: `Variant (${BUYER_INIT_INPUT.CLEAR} for none)`,
    clearable: true,
  },
  {
    key: 'quantization',
    label: `Quantization (exact catalog value; ${BUYER_INIT_INPUT.CLEAR} for none)`,
    clearable: true,
  },
  { key: 'maxTokens', label: 'Maximum output tokens' },
  {
    key: 'maxUsdc',
    label: 'Maximum spend per request in USDC (ceiling, not a payment mode)',
  },
  {
    key: 'inputUsdcPerMtok',
    label: 'Maximum input price in USDC per million tokens',
  },
  {
    key: 'outputUsdcPerMtok',
    label: 'Maximum output price in USDC per million tokens',
  },
  { key: 'discoveryUrl', label: 'Discovery index URL (availability only)' },
  { key: 'relayUrl', label: 'Configured seller relay URL' },
  { key: 'rpcUrl', label: '8004 devnet RPC URL' },
];
export async function runBuyerInit(terminal: BuyerInitTerminal): Promise<void> {
  terminal.write(
    'Configure a devnet buyer. Nothing is sent to a seller or chain.\nUse seller identities from an independent source, never a discovery listing.\nDefaults accept free quotes only.\n',
  );
  const answers = buyerInitDefaults();
  for (const field of FIELDS) {
    const value = await terminal.read(
      `${field.label} [${answers[field.key]}]: `,
    );
    if (value === undefined) {
      terminal.write('Cancelled. No initialization requested.\n');
      return;
    }
    answers[field.key] =
      field.clearable && value.trim() === BUYER_INIT_INPUT.CLEAR
        ? ''
        : value.trim() || answers[field.key];
  }
  const plan = buildBuyerInit(answers);
  terminal.write(
    `\nModel: ${plan.request.selection.modelId}; reasoning: ${plan.request.reasoning}.\nBudget ceiling: ${answers.maxUsdc} USDC per request. Prices: ${answers.inputUsdcPerMtok} input / ${answers.outputUsdcPerMtok} output USDC per million tokens.\nFree signed quotes cause no payment transactions, including with a positive ceiling.\n8004 identity verification remains enabled. Existing settings will be refused.\n`,
  );
  const confirmation = await terminal.read(
    'Save these settings and prepare the local buyer identity? [y/N]: ',
  );
  if (
    !confirmation ||
    !['y', 'yes'].includes(confirmation.trim().toLowerCase())
  ) {
    terminal.write('Cancelled. No initialization requested.\n');
    return;
  }
  await terminal.initialize(answers);
  terminal.write(
    'Buyer settings saved privately. Start with: pnpm buyer:chat\nPositive-price execution also needs its existing funded devnet wallet and verified tokenizer; this command prepares neither funds nor downloads.\n',
  );
}
export async function main() {
  if (process.argv.includes('--help')) {
    stdout.write(
      'Usage: pnpm buyer:init\nInteractive devnet setup. Existing buyer settings are never overwritten.\n',
    );
    return;
  }
  if (!stdin.isTTY) {
    console.error(
      'buyer:init needs an interactive terminal. No settings were changed.',
    );
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const input = createInterface({ input: stdin, output: stdout });
  input.on('SIGINT', () => controller.abort());
  try {
    await runBuyerInit({
      read: async (question) => {
        try {
          return await input.question(question, { signal: controller.signal });
        } catch {
          return undefined;
        }
      },
      write: (text) => {
        stdout.write(text);
      },
      initialize: (answers) =>
        initializeBuyer(answers, {
          environment: process.env,
          signal: controller.signal,
          prepareRole: () =>
            setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC }),
        }),
    });
  } catch (error) {
    console.error(
      error instanceof BuyerInitError
        ? error.code
        : 'Buyer initialization failed. Existing state was preserved.',
    );
    process.exitCode = 1;
  } finally {
    input.close();
  }
}
if (isMain(import.meta.url)) await main();
