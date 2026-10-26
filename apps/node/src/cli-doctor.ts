// `gyblos doctor`: prints the seller preflight as one line per check with a static code and a hint, then
// the public NodeId and owner to share for discovery enrollment. Never prints the home location, the RPC
// URL, the relay token or any key material.
import {
  DOCTOR_CODES,
  DOCTOR_STATUS,
  NODE_ERROR_CODES,
  OFFER_PRICING_KINDS,
} from '@gyblos/node/constants';
import { sellerDoctor, type DoctorProbes } from '@gyblos/node/seller-doctor';

import { issueLine, urlOrigin } from './cli-format.js';

const STATUS_COLUMN = 4;
const CHECK_COLUMN = 10;
const CODE_COLUMN = 34;
const SEE_STARTUP = 'see docs/configuration.md#seller-startup';
// Short operator hints by code; codes without one are explained in the docs.
const HINTS: Readonly<Record<string, string>> = {
  [DOCTOR_CODES.NO_FILE]: 'no gyblos.toml; environment-only startup',
  [DOCTOR_CODES.ROLE_MISSING]:
    'run `pnpm node:setup --role seller --mint MINT --buyer BUYER --pay-to PAYOUT`',
  [DOCTOR_CODES.ROLE_NOT_SELLER]: 'this home holds a buyer role',
  [DOCTOR_CODES.KEYS_MISSING]:
    'a key file is missing; rerun node:setup (keys are never replaced)',
  [DOCTOR_CODES.KEY_PERMISSIONS]: 'key files must be mode 0600',
  [DOCTOR_CODES.TOKENIZER_UNAVAILABLE]: 'run `pnpm gate:inference:setup`',
  [DOCTOR_CODES.OLLAMA_NOT_FOUND]: 'install Ollama and put `ollama` on PATH',
  [DOCTOR_CODES.MODEL_NOT_DOWNLOADED]: 'run `pnpm gate:inference:setup`',
  [DOCTOR_CODES.PORT_IN_USE]:
    'stop whatever answers on 127.0.0.1:11436 or :4022',
  [DOCTOR_CODES.NOT_CHECKED]: 'fix the failures above first',
  [DOCTOR_CODES.NOT_NEEDED]: 'free offers do not use the payment program',
  [DOCTOR_CODES.ONLINE_CHECK_SKIPPED]: 'run with --online to check devnet',
  [DOCTOR_CODES.DEVNET_PROGRAM_UNAVAILABLE]:
    'the role RPC is not devnet or the program is missing',
  [NODE_ERROR_CODES.NODE_CONFIG_INVALID]:
    'run `pnpm gyblos config validate --config <file>`',
  [NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT]:
    'move the old .local layout first (docs/running-a-node.md)',
  MISSING_RELAY_TOKEN:
    'set the relay token variable (default GYBLOS_RELAY_TOKEN)',
  INVALID_RELAY_TOKEN: 'the relay token must be printable, without spaces',
  INVALID_RELAY_TOKEN_LENGTH: 'the relay token must be 32-512 characters',
  INVALID_RELAY_URLS: 'relay URLs must be HTTPS origins',
};

const hint = (code: string) =>
  HINTS[code] ?? (code.startsWith('SELLER_') ? SEE_STARTUP : '');

export async function doctor(
  options: {
    env: Readonly<Record<string, string | undefined>>;
    cwd: string;
    configPath?: string;
    online: boolean;
    probes?: DoctorProbes;
  },
  output: { stdout: (text: string) => void },
) {
  const report = await sellerDoctor({
    environment: options.env,
    cwd: options.cwd,
    configPath: options.configPath,
    online: options.online,
    probes: options.probes,
  });
  const { stdout } = output;
  stdout('Seller doctor (read-only)\n');
  for (const check of report.checks) {
    const shown = check.code === DOCTOR_CODES.READY ? '' : check.code;
    const help = check.code === DOCTOR_CODES.READY ? '' : hint(check.code);
    stdout(
      `  ${check.status.padEnd(STATUS_COLUMN)}  ${check.check.padEnd(CHECK_COLUMN)} ${shown.padEnd(CODE_COLUMN)}${help}`.trimEnd() +
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
  if (report.offer) {
    stdout('Listing:\n');
    stdout(
      `  offer   ${report.offer.kind === OFFER_PRICING_KINDS.FREE ? 'free' : 'paid'} ${report.offer.modelId}\n`,
    );
    stdout(
      `  publish ${report.publication ? urlOrigin(report.publication) : 'off'}\n`,
    );
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
