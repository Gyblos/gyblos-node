// Exercises seller register through the real 8004 builder, durable state and a synthetic RPC/index.
// The transaction stays on a loopback test double; no funded keys or network transactions are used.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import test from 'node:test';

import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { runCli } from '@gyblos/node-app/cli';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import type { RoleConfig } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { addClaimant } from './support/identity-accounts';
import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';
import { withHome } from './support/status-fixture';

const INVITE = 'gyb_abcdefghijklmnopqrstuvwxyz';
const BALANCE = 100_000_000;
const COST = 12_524_640;

void test('seller CLI registers one synthetic 8004 asset before retrying the local index', () =>
  withHome(async (home) => {
    const fake = await startFakeRpc(new Map(), {
      ownerBalance: BALANCE,
      ownerAfterProbe: BALANCE - COST,
      fee: 20_000,
    });
    try {
      const key = generateKeyPairSync('ed25519').privateKey.export({
        format: 'jwk',
      });
      assert.ok(key.d && key.x);
      const ownerBytes = [
        ...Buffer.from(key.d, 'base64url'),
        ...Buffer.from(key.x, 'base64url'),
      ];
      const owner = await createKeyPairSignerFromBytes(
        Uint8Array.from(ownerBytes),
      );
      const node = await fixedSigner(7);
      const nodeId = Buffer.from(
        getAddressEncoder().encode(node.address),
      ).toString('hex');
      const role: Extract<RoleConfig, { role: typeof P2P_ROLES.SELLER }> = {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: P2P_ROLES.SELLER,
        rpcUrl: fake.url,
        mint: owner.address,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId,
        owner: owner.address,
      };
      await writeFile(joinPath(home.seller, 'role.json'), JSON.stringify(role));
      await writeFile(
        joinPath(home.seller, 'owner.json'),
        JSON.stringify(ownerBytes),
        { mode: 0o600 },
      );
      await writeFile(
        joinPath(home.seller, 'node.key'),
        JSON.stringify(Array(32).fill(7)),
        { mode: 0o600 },
      );
      const environment = { GYBLOS_HOME: home.home };
      let sent = 0;
      let indexRequests = 0;
      let approved = 0;
      fake.state.onSend = async (wire: string) => {
        sent++;
        const raw: unknown = JSON.parse(
          await readFile(
            joinPath(home.seller, 'registration-8004-v1.json'),
            'utf8',
          ),
        );
        assert.ok(
          raw &&
            typeof raw === 'object' &&
            'assetSecret' in raw &&
            Array.isArray(raw.assetSecret),
        );
        const asset = await createKeyPairSignerFromBytes(
          Uint8Array.from(raw.assetSecret),
        );
        await addClaimant(fake.state.chain, {
          owner: owner.address,
          asset: asset.address,
          node,
          agentWallet: owner.address,
        });
        fake.state.sendSignature = getSignatureFromTransaction(
          getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
        );
        fake.state.signatureStatus = {
          confirmationStatus: 'finalized',
          err: null,
        };
      };
      let stderr = '';
      const result = await runCli(['seller', 'register'], {
        env: { ...environment, GYBLOS_INVITE: INVITE },
        cwd: home.root,
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        prompt: async () => {
          approved++;
          return 'yes';
        },
        fetch: async () => {
          indexRequests++;
          return indexRequests === 1
            ? new Response(
                JSON.stringify({ error: 'IDENTITY_NOT_REGISTERED' }),
                { status: 403 },
              )
            : new Response(JSON.stringify({ ok: true, status: 'active' }), {
                status: 201,
              });
        },
      });
      assert.equal(result, 0, stderr);
      assert.equal(sent, 1);
      assert.equal(indexRequests, 2);
      assert.equal(approved, 1);
    } finally {
      await fake.close();
    }
  }));

void test('unfunded registration shows a funding estimate and missing SOL before simulation or approval', () =>
  withHome(async (home) => {
    const fake = await startFakeRpc(new Map(), {
      ownerBalance: 0,
      ownerAfterProbe: 0,
      fee: 20_000,
      initialSimulationErr: 'InsufficientFundsForRent',
    });
    try {
      const key = generateKeyPairSync('ed25519').privateKey.export({
        format: 'jwk',
      });
      assert.ok(key.d && key.x);
      const secret = [
        ...Buffer.from(key.d, 'base64url'),
        ...Buffer.from(key.x, 'base64url'),
      ];
      const owner = await createKeyPairSignerFromBytes(Uint8Array.from(secret));
      const node = await fixedSigner(7);
      const nodeId = Buffer.from(
        getAddressEncoder().encode(node.address),
      ).toString('hex');
      const role: Extract<RoleConfig, { role: typeof P2P_ROLES.SELLER }> = {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: P2P_ROLES.SELLER,
        rpcUrl: fake.url,
        mint: owner.address,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId,
        owner: owner.address,
      };
      await writeFile(joinPath(home.seller, 'role.json'), JSON.stringify(role));
      await writeFile(
        joinPath(home.seller, 'owner.json'),
        JSON.stringify(secret),
        { mode: 0o600 },
      );
      await writeFile(
        joinPath(home.seller, 'node.key'),
        JSON.stringify(Array(32).fill(7)),
        { mode: 0o600 },
      );
      let stdout = '';
      let stderr = '';
      let approvals = 0;
      const waited: bigint[] = [];
      const result = await runCli(['seller', 'register'], {
        env: { GYBLOS_HOME: home.home, GYBLOS_INVITE: INVITE },
        cwd: home.root,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        prompt: async () => {
          approvals++;
          return 'yes';
        },
        // On a terminal it waits for the SOL; here none arrives.
        waitForFunds: async (_owner, lamports, onWaiting) => {
          waited.push(lamports);
          onWaiting();
          return 'timeout';
        },
        fetch: async () =>
          new Response(JSON.stringify({ error: 'IDENTITY_NOT_REGISTERED' }), {
            status: 403,
          }),
      });
      assert.equal(result, 1);
      assert.match(stdout, /Pre-simulation funding estimate: 0\.012544640 SOL/);
      assert.match(
        stdout,
        /needs 0\.012544640 more SOL.*\n.*\n.*Waiting for it/,
      );
      assert.deepEqual(waited, [12544640n]);
      assert.match(stderr, /you need 0\.012544640 more SOL/);
      assert.equal(approvals, 0);
      assert.equal(fake.state.calls.includes('simulateTransaction'), false);
      assert.equal(fake.state.calls.includes('sendTransaction'), false);
    } finally {
      await fake.close();
    }
  }));
