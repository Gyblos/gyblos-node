// Creates explicit buyer trust from independently checked identities and a verified local offer.
// Refuses to replace existing trust; never loads private keys, funds wallets or contacts RPC.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { FILE_MODES, P2P } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/node/constants';
import { parseOfferTrust, verifyInferenceOffer } from '@gyblos/node/offers';
import { loadRole, rolePath } from '@gyblos/node/roles';
import { isMain } from '@gyblos/runtime';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      owner: { type: 'string' },
      'node-id': { type: 'string' },
      'pay-to': { type: 'string' },
      'max-atomic': { type: 'string' },
    },
  });
  const config = await loadRole();
  if (config.role !== P2P_ROLES.BUYER) throw new Error('Buyer role required.');
  const trust = parseOfferTrust({
    owner: values.owner,
    nodeId: values['node-id'],
    payTo: values['pay-to'],
    maxAtomic: values['max-atomic'],
    buyer: config.buyer,
    mint: config.mint,
  });
  const bytes = await readFile(rolePath(P2P.offerFilename));
  if (bytes.length > P2P.bodyBytes) throw new Error('Offer exceeds bounds.');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const offer = await verifyInferenceOffer(value, trust);
  if (offer.endpoint.relayUrl) assertConfiguredRelay(offer.endpoint.relayUrl);
  await writeFile(
    rolePath(P2P.trustFilename),
    JSON.stringify(trust, null, 2) + '\n',
    {
      flag: 'wx',
      mode: FILE_MODES.privateFile,
    },
  );
  console.log(
    'Buyer trust created from the verified offer and explicit identities.',
  );
}

if (isMain(import.meta.url)) await main();
