// `gyblos doctor`: prints the seller preflight as one line per check with a static code and a hint, then
// the public NodeId and owner to share for discovery enrollment. Never prints the home location, the RPC
// URL, the relay token or any key material.
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  DOCTOR_STATUS,
  NODE_ERROR_CODES,
} from '@gyblos/node/constants';
import {
  sellerDoctor,
  type DoctorProbes,
  type DoctorResultCode,
} from '@gyblos/node/seller-doctor';
import { ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';

import { issueLine, urlOrigin } from './cli-format';

const STATUS_COLUMN = 4;
const CHECK_COLUMN = 10;
const CODE_COLUMN = 34;
const SEE_STARTUP = 'see docs/configuration.md#seller-startup';
// Short operator hints by code; codes without one are explained in the docs.
const HINTS: Readonly<Partial<Record<DoctorResultCode, string>>> = {
  [DOCTOR_CODES.ROLE_MISSING]:
    'run `pnpm node:setup --role seller --mint MINT`',
  [DOCTOR_CODES.ROLE_NOT_SELLER]: 'this home holds a buyer role',
  [DOCTOR_CODES.KEYS_MISSING]:
    'a key file is missing; rerun node:setup (keys are never replaced)',
  [DOCTOR_CODES.KEY_PERMISSIONS]:
    'key files must be regular files owned by you, mode 0600',
  [DOCTOR_CODES.SEQUENCE_LOCK_PRESENT]:
    'a leftover public-sequence lock blocks publishing; stop other sellers, then inspect it (docs/discovery.md)',
  [NODE_ERROR_CODES.PUBLIC_SEQUENCE_UNAVAILABLE]:
    'the seller directory must be mode 0700 and its public-sequence file valid',
  [DOCTOR_CODES.TOKENIZER_UNAVAILABLE]: 'run `pnpm node:tokenizer`',
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
    'remote engine; `pnpm gyblos doctor --online` lists its models (some providers list them without checking the key)',
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
    'paid offers need a seller role with a payout: in a new GYBLOS_HOME, `pnpm node:setup --role seller --mint <mint> --pay-to <payout> --buyer <any address you control>`; fund the fee payer with devnet SOL',
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
    'the payout must differ from the owner, fee payer and authorizer keys',
  [NODE_ERROR_CODES.NODE_CONFIG_INVALID]:
    'run `pnpm gyblos config validate --config <file>` on the GYBLOS_CONFIG file',
  [NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT]:
    'move the old .local layout first (docs/running-a-node.md)',
  [RELAY_CONFIGURATION_CODES.MISSING_TOKEN]:
    'set the relay token variable (default GYBLOS_RELAY_TOKEN)',
  [RELAY_CONFIGURATION_CODES.INVALID_TOKEN]:
    'the relay token must be printable, without spaces',
  [RELAY_CONFIGURATION_CODES.INVALID_TOKEN_LENGTH]:
    'the relay token must be 32-512 characters',
  [RELAY_CONFIGURATION_CODES.INVALID_URLS]: 'relay URLs must be HTTPS origins',
  [DOCTOR_CODES.CLOCK_SKEWED]:
    'this clock is over 2 s off the discovery index; turn on automatic time sync (NTP), since buyers refuse records issued over 5 s ahead',
  [DOCTOR_CODES.CLOCK_UNCHECKED]:
    'the discovery index did not report its time; check the connection',
};

const hint = (code: DoctorResultCode) =>
  HINTS[code] ?? (code.startsWith('SELLER_') ? SEE_STARTUP : '');

export async function doctor(
  options: {
    env: Readonly<Record<string, string | undefined>>;
    cwd: string;
    probes?: DoctorProbes;
    online: boolean;
  },
  output: { stdout: (text: string) => void },
) {
  const report = await sellerDoctor({
    environment: options.env,
    cwd: options.cwd,
    probes: options.probes,
    online: options.online,
  });
  const { stdout } = output;
  stdout('Seller doctor (read-only)\n');
  for (const check of report.checks) {
    const shown = check.code === DOCTOR_CODES.READY ? '' : check.code;
    // A per-offer check names its [[offers]] entry, counted from 1 as in the hints.
    const name =
      check.check === DOCTOR_CHECKS.ENGINE && check.offer !== undefined
        ? `${check.check}[${check.offer + 1}]`
        : check.check;
    const where =
      check.offer === undefined || name !== check.check
        ? ''
        : `[[offers]] entry ${check.offer + 1}: `;
    const help =
      check.code === DOCTOR_CODES.READY ? '' : where + hint(check.code);
    stdout(
      `  ${check.status.padEnd(STATUS_COLUMN)}  ${name.padEnd(CHECK_COLUMN)} ${shown.padEnd(CODE_COLUMN)}${help}`.trimEnd() +
        '\n',
    );
  }
  for (const issue of report.configIssues)
    stdout(`        ${issueLine(issue)}`);
  if (report.seller) {
    stdout('Seller identity (public; share it to be enrolled in discovery):\n');
    stdout(`  nodeId  ${report.seller.nodeId}\n`);
    stdout(`  owner   ${report.seller.owner}\n`);
  }
  if (report.offers) {
    stdout('Listing:\n');
    report.offers.forEach((offer, index) =>
      stdout(`  offer[${index + 1}] ${offer.kind} ${offer.modelId}\n`),
    );
    stdout(
      `  publish ${report.publication ? urlOrigin(report.publication) : 'off'}\n`,
    );
  }
  if (report.limits) {
    const { transport, maxFreeBuyers } = report.limits;
    stdout('Limits (effective; gyblos.toml [limits] over the defaults):\n');
    stdout(`  connections ${transport.maxConnections} total\n`);
    stdout(
      `  requests    ${transport.requestsPerWindow}/min per buyer, ${transport.globalRequestsPerWindow}/min total\n`,
    );
    if (report.offers)
      stdout(`  free buyers ${maxFreeBuyers}/day across all offers\n`);
  }
  const failures = report.checks.filter(
    (check) => check.status === DOCTOR_STATUS.FAIL,
  ).length;
  stdout(
    failures
      ? `Result: NOT READY (${failures} failure(s))\n`
      : 'Result: READY\n',
  );
  return failures === 0;
}
