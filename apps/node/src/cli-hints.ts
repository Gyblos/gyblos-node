// Short operator hints by static code, shared by `gyblos doctor`, `gyblos seller status` and the daemon's
// one-line startup failure, written as `gyblos <command>` (from a checkout, `pnpm gyblos <command>`).
// Kept apart from the doctor command so the daemon entry does not load it.
import { runMode } from '@gyblos/config';
import { DOCTOR_CODES, NODE_ERROR_CODES } from '@gyblos/node/constants';
import type { DoctorResultCode } from '@gyblos/node/seller-doctor';
import { ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';

import { commandsFor } from './cli-next';

const SEE_STARTUP = 'see docs/configuration.md#seller-startup';
// Short operator hints by code; codes without one are explained in the docs.
const HINTS: Readonly<Partial<Record<DoctorResultCode, string>>> = {
  [DOCTOR_CODES.ROLE_MISSING]: 'run `gyblos setup --role seller --mint MINT`',
  [DOCTOR_CODES.ROLE_NOT_SELLER]: 'this home holds a buyer role',
  [DOCTOR_CODES.KEYS_MISSING]:
    'a key file is missing; rerun `gyblos setup` (keys are never replaced)',
  [DOCTOR_CODES.KEY_PERMISSIONS]:
    'key files must be regular single-link files owned by you, mode 0600 (on Windows: only your account may open the home, the seller folder and the keys; `gyblos setup` again restricts the seller folder and keys, and a GYBLOS_HOME others can open must be moved; this also shows when PowerShell is blocked and the permissions cannot be read)',
  [DOCTOR_CODES.SEQUENCE_LOCK_PRESENT]:
    'a leftover public-sequence lock blocks publishing; stop other sellers, then inspect it (docs/discovery.md)',
  [NODE_ERROR_CODES.PUBLIC_SEQUENCE_UNAVAILABLE]:
    'the seller directory must be mode 0700 and its public-sequence file valid',
  [DOCTOR_CODES.TOKENIZER_UNAVAILABLE]: 'run `gyblos tokenizer`',
  [ENGINE_ERROR_CODES.UNAVAILABLE]:
    'start the engine at the offer URL with its model; for Ollama, `ollama pull qwen3:0.6b`, and `ollama list` must show ID 7df6b6e09427; for an API, check upstream_model is listed',
  [ENGINE_ERROR_CODES.TIMEOUT]:
    'the engine at the offer URL did not answer in time; check that it is running',
  [ENGINE_ERROR_CODES.AUTH]:
    'the engine refused the API key; check the variable named by api_key_env',
  [ENGINE_ERROR_CODES.QUOTA_EXHAUSTED]:
    'the API account has no credit left; free offers stop until it is topped up',
  [ENGINE_ERROR_CODES.RATE_LIMITED]:
    'the API is rate limiting this key; try again later or raise its limit',
  [DOCTOR_CODES.NOT_CHECKED]: 'fix the failures above first',
  [DOCTOR_CODES.REMOTE_ENGINE_NOT_CHECKED]:
    'remote engine; `gyblos doctor --online` lists its models (some providers list them without checking the key)',
  [NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING]:
    'set the variable named by api_key_env',
  [NODE_ERROR_CODES.SELLER_OFFER_API_KEY_UNSAFE]:
    'api_key_env must name the provider key itself, never a GYBLOS_* or relay token variable',
  [NODE_ERROR_CODES.SELLER_OFFERS_MISSING]:
    'add a free [[offers]] entry to gyblos.toml (examples/seller-daemon.toml)',
  [NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE]:
    'paid offers need the payment chain; list the offer as free',
  [NODE_ERROR_CODES.SELLER_PAID_METERING_UNRECOUNTED]:
    'a paid offer needs a model recounted with its pinned public tokenizer (qwen3-0.6b)',
  [NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING]:
    'this seller has no payment keys yet: run `gyblos setup --role seller --mint <mint>` again (installed with install.sh: rerun it); it keeps the NodeId and owner. Then fund the fee payer with devnet SOL',
  [NODE_ERROR_CODES.SELLER_PAYMENT_NETWORK_MISMATCH]:
    'paid selling runs on devnet only; set the role up with a devnet RPC',
  [NODE_ERROR_CODES.SELLER_PAYMENT_ACCOUNTS_UNAVAILABLE]:
    'fund the fee payer with devnet SOL and check the RPC; startup creates the payout, fee and fee payer token accounts, and refuses a frozen one',
  [DOCTOR_CODES.PAYMENT_ACCOUNTS_MISSING]:
    'startup creates the missing payout, fee or fee payer token account, about 0.002 devnet SOL each from the fee payer',
  [DOCTOR_CODES.PAYMENT_ACCOUNTS_UNCHECKED]:
    'the RPC did not answer; startup checks the token accounts again',
  [DOCTOR_CODES.PAYMENT_ACCOUNTS_UNUSABLE]:
    'a payout, fee or fee payer token account is frozen or is not a token account; startup refuses it until it can receive payouts',
  [NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID]:
    'the payout must differ from the fee payer and authorizer keys',
  [NODE_ERROR_CODES.NODE_CONFIG_INVALID]:
    'run `gyblos config validate --config <file>` on the GYBLOS_CONFIG file',
  [NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT]:
    'move the old .local layout first (docs/running-a-node.md)',
  [RELAY_CONFIGURATION_CODES.MISSING_TOKEN]:
    'set the relay token variable (default GYBLOS_RELAY_TOKEN)',
  [RELAY_CONFIGURATION_CODES.INVALID_TOKEN]:
    'the relay token must be printable, without spaces',
  [RELAY_CONFIGURATION_CODES.INVALID_TOKEN_LENGTH]:
    'the relay token must be 32-512 characters',
  [RELAY_CONFIGURATION_CODES.INVALID_URLS]: 'relay URLs must be HTTPS origins',
  [NODE_ERROR_CODES.SELLER_RELAY_OFFLINE]:
    'no Gyblos relay answered: check the relay token from your invitation (GYBLOS_RELAY_TOKEN, in seller.env with Docker) and that this machine can reach the internet',
  [DOCTOR_CODES.CLOCK_SKEWED]:
    'this clock is over 2 s off the discovery index; turn on automatic time sync (NTP): buyers refuse records issued over 5 s ahead, and a clock behind shortens every quote',
  [DOCTOR_CODES.CLOCK_UNCHECKED]:
    'the discovery index did not report its time quickly; check the connection and run doctor again',
};

// Own keys only, so a crafted code such as "constructor" read from status.json gets no hint. Commands are
// spelled for how this seller was installed.
export const codeHint = (
  code: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) =>
  commandsFor(
    runMode(environment),
    Object.hasOwn(HINTS, code)
      ? (HINTS[code as DoctorResultCode] ?? '')
      : code.startsWith('SELLER_')
        ? SEE_STARTUP
        : '',
  );
