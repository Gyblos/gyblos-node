// `gyblos doctor`: prints the seller preflight as one line per check with a static code and a hint, then
// the public NodeId and owner to share for discovery enrollment. Never prints the home location, the RPC
// URL, the relay token or any key material.
import { runMode } from '@gyblos/config';
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  DOCTOR_STATUS,
} from '@gyblos/node/constants';
import { sellerDoctor, type DoctorProbes } from '@gyblos/node/seller-doctor';

import { issueLine, urlOrigin } from './cli-format';
import { codeHint } from './cli-hints';
import { commandsFor } from './cli-next';

const STATUS_COLUMN = 4;
const CHECK_COLUMN = 10;
const CODE_COLUMN = 34;

const identityHeading = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  commandsFor(
    runMode(environment),
    'Seller identity (public; `gyblos seller register` enrolls it in discovery):\n',
  );

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
      check.code === DOCTOR_CODES.READY
        ? ''
        : where + codeHint(check.code, options.env);
    stdout(
      `  ${check.status.padEnd(STATUS_COLUMN)}  ${name.padEnd(CHECK_COLUMN)} ${shown.padEnd(CODE_COLUMN)}${help}`.trimEnd() +
        '\n',
    );
  }
  for (const issue of report.configIssues)
    stdout(`        ${issueLine(issue)}`);
  if (report.seller) {
    stdout(identityHeading(options.env));
    stdout(`  nodeId  ${report.seller.nodeId}\n`);
    stdout(`  owner   ${report.seller.owner}\n`);
    if (report.seller.feePayer)
      stdout(
        `  fee payer  ${report.seller.feePayer}  (pays priced offers' transactions; needs devnet SOL only to charge)\n`,
      );
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
