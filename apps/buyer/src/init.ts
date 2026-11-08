// Guided terminal entry for shared buyer initialization; no discovery query, inference or payment.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { DEVNET_USDC, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import {
  buildBuyerInit,
  buyerInitDefaults,
  BuyerInitError,
  checkBuyerInit,
  initializeBuyer,
  validateBuyerInitField,
  type BuyerInitAnswers,
} from '@gyblos/node/buyer-init';
import {
  BUYER_INIT_CODES,
  BUYER_INIT_FIELDS,
  BUYER_INIT_MODES,
  type BuyerInitField,
  type BuyerInitMode,
} from '@gyblos/node/buyer-init-constants';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { BUYER_INIT_INPUT } from './constants';

export interface BuyerInitTerminal {
  preflight(): Promise<{ path: string; exists: boolean }>;
  read(question: string): Promise<string | undefined>;
  write(text: string): void;
  initialize(input: BuyerInitAnswers): Promise<unknown>;
}
const FIELDS: readonly {
  key: BuyerInitField;
  label: string;
  hint: string;
  clearable?: boolean;
}[] = [
  {
    key: BUYER_INIT_FIELDS.SELLER_NODE_ID,
    label: 'Seller NodeId (from an independent trusted source)',
    hint: 'Use exactly 64 lowercase hexadecimal characters from an independent source.',
  },
  {
    key: BUYER_INIT_FIELDS.SELLER_OWNER,
    label: 'Seller owner wallet (verified against 8004 at runtime)',
    hint: 'Use the seller owner’s valid Solana address from an independent source.',
  },
  {
    key: BUYER_INIT_FIELDS.MODEL_ID,
    label: 'Model ID (exact catalog value)',
    hint: 'Use a nonempty bounded model name without control characters.',
  },
  {
    key: BUYER_INIT_FIELDS.VARIANT,
    label: `Variant (${BUYER_INIT_INPUT.CLEAR} for none)`,
    clearable: true,
    hint: 'Use the exact bounded catalog variant, or - for none.',
  },
  {
    key: BUYER_INIT_FIELDS.QUANTIZATION,
    label: `Quantization (exact catalog value; ${BUYER_INIT_INPUT.CLEAR} for none)`,
    clearable: true,
    hint: 'Use the exact bounded catalog quantization, or - for none.',
  },
  {
    key: BUYER_INIT_FIELDS.MAX_TOKENS,
    label: 'Maximum output tokens',
    hint: `Use a whole number from 1 to ${INFERENCE_REQUEST_LIMITS.maxOutputTokens}, without leading zeros.`,
  },
  {
    key: BUYER_INIT_FIELDS.MAX_USDC,
    label: 'Maximum spend per request in USDC (ceiling, not a payment mode)',
    hint: 'Use a bounded nonnegative USDC amount with micro-USDC precision; no leading zeros or exponents. Trailing fractional zeros are allowed.',
  },
  {
    key: BUYER_INIT_FIELDS.INPUT_PRICE,
    label: 'Maximum input price in USDC per million tokens',
    hint: 'Use a bounded nonnegative USDC price with micro-USDC precision; no leading zeros or exponents. Trailing fractional zeros are allowed.',
  },
  {
    key: BUYER_INIT_FIELDS.OUTPUT_PRICE,
    label: 'Maximum output price in USDC per million tokens',
    hint: 'Use a bounded nonnegative USDC price with micro-USDC precision; no leading zeros or exponents. Trailing fractional zeros are allowed.',
  },
  {
    key: BUYER_INIT_FIELDS.DISCOVERY_URL,
    label: 'Discovery index URL (availability only)',
    hint: 'Use HTTPS, or loopback HTTP, without credentials, query or fragment.',
  },
  {
    key: BUYER_INIT_FIELDS.RELAY_URL,
    label: 'Configured seller relay URL',
    hint: 'Use a relay already allowed by GYBLOS_RELAYS; the relay allowlist remains enforced.',
  },
  {
    key: BUYER_INIT_FIELDS.RPC_URL,
    label: '8004 devnet RPC URL',
    hint: 'Use HTTPS, or loopback HTTP, without credentials, query or fragment.',
  },
];
async function readField(
  terminal: BuyerInitTerminal,
  field: (typeof FIELDS)[number],
  previous: string,
) {
  for (;;) {
    const value = await terminal.read(`${field.label} [${previous}]: `);
    if (value === undefined) return undefined;
    const candidate =
      field.clearable && value.trim() === BUYER_INIT_INPUT.CLEAR
        ? ''
        : value.trim() || previous;
    try {
      return validateBuyerInitField(field.key, candidate);
    } catch (error) {
      if (!(error instanceof BuyerInitError)) throw error;
      terminal.write(`Invalid ${field.label}. ${field.hint}\n`);
    }
  }
}
export async function runBuyerInit(
  terminal: BuyerInitTerminal,
  _mode: BuyerInitMode = BUYER_INIT_MODES.SHORT,
): Promise<void> {
  const preflight = await terminal.preflight();
  if (preflight.exists) {
    terminal.write(
      `Buyer settings already exist at ${JSON.stringify(preflight.path)}. Edit that selection file to reconfigure; keep the buyer home, keys and journals. A separate GYBLOS_HOME creates a separate identity.\n`,
    );
    throw new BuyerInitError(BUYER_INIT_CODES.EXISTS);
  }
  terminal.write(
    'Configure a devnet buyer. Nothing is sent to a seller or chain.\nUse seller identities from an independent source, never a discovery listing.\nDefaults accept free quotes only.\n',
  );
  const answers = buyerInitDefaults();
  for (const field of FIELDS) {
    const value = await readField(terminal, field, answers[field.key]);
    if (value === undefined) {
      terminal.write('Cancelled. No initialization requested.\n');
      return;
    }
    answers[field.key] = value;
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
    'Buyer settings saved privately. Set GYBLOS_RELAY_TOKEN privately in the chat environment, then start with: pnpm buyer:chat\nUse GYBLOS_RELAYS if your seller uses another approved relay. Never share the token or put it in selection.json.\nPositive-price execution also needs its existing funded devnet wallet and verified tokenizer; this command prepares neither funds nor downloads.\n',
  );
}
const INITIALIZATION_HINTS: Readonly<Record<BuyerInitError['code'], string>> = {
  [BUYER_INIT_CODES.INVALID]:
    'Review the form values; see docs/buyer-init.md. Existing state was preserved.',
  [BUYER_INIT_CODES.EXISTS]:
    'Existing settings were preserved. Edit selection.json to reconfigure; keep the buyer home, keys and journals.',
  [BUYER_INIT_CODES.UNAVAILABLE]:
    'Check private paths and whether another initialization is running. If the existing role uses another mint, use a separate GYBLOS_HOME; keep the old home for recovery. See docs/buyer-init.md.',
};
export function buyerInitMessage(error: unknown) {
  if (!(error instanceof BuyerInitError))
    return 'Buyer initialization failed. Existing state was preserved.';
  const field = FIELDS.find((item) => item.key === error.field);
  const hint = field
    ? `${field.label}: ${field.hint}`
    : INITIALIZATION_HINTS[error.code];
  return `${error.code}: ${hint}`;
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
      preflight: () => checkBuyerInit(process.env),
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
    console.error(buyerInitMessage(error));
    process.exitCode = 1;
  } finally {
    input.close();
  }
}
if (isMain(import.meta.url)) await main();
