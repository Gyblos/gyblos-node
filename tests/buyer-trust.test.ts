// Creates buyer trust only from explicit identities and a locally verified synthetic signed offer.
// Fixtures own their temporary files and unfunded signers; no operational keys or RPC are used.
import assert from 'node:assert/strict';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { FILE_MODES, MAX_ATOMIC, ROLE_FILES } from '@gyblos/config';
import type { OfferTrust } from '@gyblos/core/offers';
import { NODE_ERROR_CODES, P2P_ROLES } from '@gyblos/node/constants';
import type { SignedInferenceOffer } from '@gyblos/protocol/offer';
import { loadJson } from '@gyblos/runtime';
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime.js';

const OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };

async function withTrust(
  run: (
    main: (args: string[]) => Promise<void>,
    trust: OfferTrust,
    path: string,
  ) => Promise<void>,
  relayUrl: string | null = null,
) {
  const { withRelayOffer } = await import('./support/relay-fixture.js');
  const { main } = await import('@gyblos/buyer/trust');
  const { rolePath } = await import('@gyblos/node/roles');
  await withRelayOffer(relayUrl, async () => {
    const path = rolePath(P2P_ROLES.BUYER, ROLE_FILES.trust);
    const trust = await loadJson<OfferTrust>(path);
    await unlink(path);
    await run(main, trust, path);
  });
}

function args(trust: OfferTrust) {
  return [
    '--owner',
    trust.owner,
    '--node-id',
    trust.nodeId,
    '--pay-to',
    trust.payTo,
    '--max-atomic',
    MAX_ATOMIC,
  ];
}

void test(
  'buyer trust creation verifies the offer and never overwrites existing trust',
  OPTIONS,
  async () => {
    await withTrust(async (main, trust, path) => {
      await main(args(trust));
      const { parseOfferTrustJson } = await import('@gyblos/node/offers');
      assert.deepEqual(
        parseOfferTrustJson(await readFile(path, 'utf8')),
        trust,
      );
      assert.equal(
        (await lstat(path)).mode & FILE_MODES.permissionMask,
        FILE_MODES.privateFile,
      );
      const before = await readFile(path, 'utf8');
      await assert.rejects(main(args(trust)), { code: 'EEXIST' });
      assert.equal(await readFile(path, 'utf8'), before);
    });
  },
);

void test(
  'buyer trust creation rejects a signature mismatch before writing trust',
  OPTIONS,
  async () => {
    await withTrust(async (main, trust, path) => {
      const { rolePath } = await import('@gyblos/node/roles');
      const { saveJson } = await import('@gyblos/runtime');
      const offerPath = rolePath(P2P_ROLES.BUYER, ROLE_FILES.offer);
      const signed = await loadJson<SignedInferenceOffer>(offerPath);
      await saveJson(offerPath, {
        ...signed,
        signature: Buffer.alloc(64).toString('base64'),
      });
      await assert.rejects(main(args(trust)), /signature/);
      await assert.rejects(lstat(path), { code: 'ENOENT' });
    });
  },
);

void test(
  'buyer trust creation refuses to infer the seller identity from the offer',
  OPTIONS,
  async () => {
    await withTrust(async (main, trust, path) => {
      await assert.rejects(main(['--max-atomic', MAX_ATOMIC]));
      await assert.rejects(lstat(path), { code: 'ENOENT' });
      await assert.rejects(
        main(args({ ...trust, nodeId: '3'.repeat(64) })),
        /Untrusted/,
      );
      await assert.rejects(lstat(path), { code: 'ENOENT' });
    });
  },
);

void test(
  'buyer trust reports malformed offer JSON without exposing its contents',
  OPTIONS,
  async () => {
    await withTrust(async (main, trust, path) => {
      const { rolePath } = await import('@gyblos/node/roles');
      await writeFile(
        rolePath(P2P_ROLES.BUYER, ROLE_FILES.offer),
        'SYNTHETIC_PRIVATE_OFFER_SENTINEL',
      );
      await assert.rejects(main(args(trust)), {
        code: NODE_ERROR_CODES.INVALID_SIGNED_OFFER,
        message: NODE_ERROR_CODES.INVALID_SIGNED_OFFER,
      });
      await assert.rejects(lstat(path), { code: 'ENOENT' });
    });
  },
);

void test(
  'buyer trust rejects an unconfigured relay without writing trust',
  OPTIONS,
  async () => {
    const previous = process.env.GYBLOS_RELAYS;
    try {
      process.env.GYBLOS_RELAYS = 'https://configured.example';
      await withTrust(async (main, trust, path) => {
        await assert.rejects(main(args(trust)), {
          code: RELAY_CONFIGURATION_CODES.UNCONFIGURED,
        });
        await assert.rejects(lstat(path), { code: 'ENOENT' });
      }, 'https://unconfigured.example');
    } finally {
      if (previous === undefined) delete process.env.GYBLOS_RELAYS;
      else process.env.GYBLOS_RELAYS = previous;
    }
  },
);
