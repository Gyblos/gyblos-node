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
    'run `pnpm node:setup --role seller --mint MINT --buyer BUYER --pay-to PAYOUT`',
  [DOCTOR_CODES.ROLE_NOT_SELLER]: 'this home holds a buyer role',
  [DOCTOR_CODES.KEYS_MISSING]:
    'a key file is missing; rerun node:setup (keys are never replaced)',
  [DOCTOR_CODES.KEY_PERMISSIONS]:
    'key files must be regular files owned by you, mode 0600',
  [DOCTOR_CODES.SEQUENCE_LOCK_PRESENT]:
    'a leftover public-sequence lock blocks publishing; stop other sellers, then inspect it (docs/discovery.md)',
  [NODE_ERROR_CODES.PUBLIC_SEQUENCE_UNAVAILABLE]:
    'the seller directory must be mode 0700 and its public-sequence file valid',
  [DOCTOR_CODES.TOKENIZER_UNAVAILABLE]: 'run `pnpm gate:inference:setup`',
  [ENGINE_ERROR_CODES.UNAVAILABLE]:
    'start the engine at the offer URL with the pinned model; for Ollama, `ollama pull qwen3:0.6b`, and `ollama list` must show ID 7df6b6e09427',
  [ENGINE_ERROR_CODES.TIMEOUT]:
    'the engine at the offer URL did not answer in time; check that Ollama is running',
  [DOCTOR_CODES.NOT_CHECKED]: 'fix the failures above first',
  [NODE_ERROR_CODES.SELLER_OFFERS_MISSING]:
    'add a free [[offers]] entry to gyblos.toml (examples/seller-daemon.toml)',
  [NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE]:
    'paid selling is off until it returns as a plugin; list the offer as free',
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
};

const hint = (code: DoctorResultCode) =>
  HINTS[code] ?? (code.startsWith('SELLER_') ? SEE_STARTUP : '');

export async function doctor(
  options: {
    env: Readonly<Record<string, string | undefined>>;
    cwd: string;
    probes?: DoctorProbes;
  },
  output: { stdout: (text: string) => void },
) {
  const report = await sellerDoctor({
    environment: options.env,
    cwd: options.cwd,
    probes: options.probes,
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
      check.offer === undefined ? '' : `[[offers]] entry ${check.offer + 1}: `;
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
      stdout(`  offer[${index + 1}] free ${offer.modelId}\n`),
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
