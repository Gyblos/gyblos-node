import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import { address } from '@solana/kit';
import type { SupportedResponse } from '@x402/core/types';

import { EXACT_PRICE } from '@gyblos/application/constants';
import {
  EVIDENCE_PATHS,
  JOURNAL_PATHS,
  LOCALHOST,
  LOCK_PATH,
  ROUTES,
  TIMEOUTS,
} from '@gyblos/config';
import { loadConfig, saveJson } from '@gyblos/lab-harness/config';
import {
  CASE_STATUSES,
  EVIDENCE_STATUSES,
  EXACT_CASES,
  EXACT_EVIDENCE_CODES,
  FACILITATOR_STATUSES,
  JOURNAL_STATES,
} from '@gyblos/lab-harness/constants';
import { prepareExactAccounts } from '@gyblos/lab-harness/exact-accounts';
import { assertNoUnresolvedAuthorizations } from '@gyblos/lab-harness/journal';
import { withExclusiveLock } from '@gyblos/lab-harness/lock';
import { assertDevnet, GateError, tokens } from '@gyblos/payments-x402/chain';
import { DEVNET_USDC, GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';
import {
  assertExactSupport,
  PUBLIC_FACILITATORS,
} from '@gyblos/payments-x402/exact/index';
import { UNKNOWN_ERROR_NAME } from '@gyblos/runtime/constants';
import {
  AuditedPublicFacilitator,
  createExactSeller,
} from '@gyblos/seller/exact';

import { runProvider } from './cases.js';
import { createEvidence } from './evidence.js';

export async function main() {
  const evidencePath = EVIDENCE_PATHS.exact,
    journalPath = JOURNAL_PATHS.exact;
  const evidence = createEvidence();
  async function persist() {
    await saveJson(evidencePath, evidence);
  }
  async function run() {
    try {
      const previous = JSON.parse(await readFile(evidencePath, 'utf8'));
      evidence.previousAttempts = [
        ...(previous.previousAttempts ?? []),
        { ...previous, previousAttempts: undefined },
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const config = await loadConfig();
    await assertDevnet(config.rpcUrl);
    await assertNoUnresolvedAuthorizations();
    try {
      const previousJournal = JSON.parse(await readFile(journalPath, 'utf8'));
      if (
        ![JOURNAL_STATES.CONFIRMED, JOURNAL_STATES.REJECTED].includes(
          previousJournal.state,
        )
      )
        throw new GateError(
          GATE_ERROR_CODES.UNRESOLVED_EXACT,
          'Previous exact payment is uncertain. Reconcile before another attempt.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Snapshot both providers before any payment. Pin capability/fee payer; dynamic blockhashes may change.
    const providers: {
      url: string;
      feePayer: string;
      supported: SupportedResponse;
    }[] = [];
    for (const provider of PUBLIC_FACILITATORS) {
      try {
        const response = await fetch(provider.url + ROUTES.supported, {
          signal: AbortSignal.timeout(TIMEOUTS.rpc),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const supported = (await response.json()) as SupportedResponse;
        evidence.facilitators.push({
          ...provider,
          fetchedAt: new Date().toISOString(),
          httpStatus: response.status,
          supported,
        });
        await persist();
        assertExactSupport(supported, provider.feePayer);
        providers.push({ ...provider, supported });
      } catch (error) {
        if (
          error instanceof GateError &&
          error.code === GATE_ERROR_CODES.SUPPORT_CHANGED
        )
          throw error;
        evidence.facilitators.push({
          url: provider.url,
          status: FACILITATOR_STATUSES.UNAVAILABLE,
          reason: error instanceof Error ? error.name : UNKNOWN_ERROR_NAME,
        });
        await persist();
      }
    }
    if (!providers.length)
      throw new GateError(
        GATE_ERROR_CODES.NO_PUBLIC_FACILITATOR,
        'Both public facilitators unavailable.',
      );
    evidence.setupTransaction = await prepareExactAccounts(config);
    await persist();
    if (
      (await tokens(config.rpcUrl, config.addresses.buyer, DEVNET_USDC)) <
      BigInt(EXACT_PRICE)
    )
      throw new GateError(
        GATE_ERROR_CODES.NEEDS_CIRCLE_USDC,
        `Fund buyer ${config.addresses.buyer} using faucet.circle.com on Solana Devnet.`,
      );
    for (const provider of providers) {
      const facilitator = new AuditedPublicFacilitator(
        provider.url,
        provider.feePayer,
      );
      let host: Awaited<ReturnType<typeof createExactSeller>>;
      try {
        host = await createExactSeller({
          rpcUrl: config.rpcUrl,
          payTo: config.addresses.seller,
          facilitator,
        });
      } catch (error) {
        if (
          error instanceof GateError &&
          error.code === GATE_ERROR_CODES.SUPPORT_CHANGED
        )
          throw error;
        evidence.results.push({
          facilitator: provider.url,
          case: EXACT_CASES.STARTUP,
          status: CASE_STATUSES.EXTERNAL_UNAVAILABLE,
          reason: error instanceof Error ? error.name : UNKNOWN_ERROR_NAME,
        });
        await persist();
        continue;
      }
      evidence.facilitatorUsed = provider.url;
      const server = host.app.listen(0, LOCALHOST);
      await once(server, 'listening');
      const serverAddress = server.address();
      assert.ok(serverAddress && typeof serverAddress !== 'string');
      const url = `http://${LOCALHOST}:${serverAddress.port}${ROUTES.exact}`;
      try {
        if (
          await runProvider({
            config: config,
            provider,
            host,
            facilitator,
            url,
            evidence,
            persist,
            journalPath,
            evidencePath,
          })
        )
          return;
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    throw new GateError(
      GATE_ERROR_CODES.PUBLIC_PROVIDERS_REJECTED,
      'No public facilitator completed the exact payment; inspect evidence.',
    );
  }
  let acquired = false;
  try {
    await withExclusiveLock(LOCK_PATH, async () => {
      acquired = true;
      await run();
    });
  } catch (error) {
    if (evidence.status !== EVIDENCE_STATUSES.UNCERTAIN)
      evidence.status = EVIDENCE_STATUSES.BLOCKED;
    evidence.error = {
      code:
        error instanceof GateError
          ? error.code
          : EXACT_EVIDENCE_CODES.GATE_ERROR,
      name: error instanceof Error ? error.name : UNKNOWN_ERROR_NAME,
      message:
        error instanceof GateError
          ? error.message
          : 'Check public results and local journal; no automatic retry.',
    };
    if (acquired) await persist();
    console.error(
      JSON.stringify({
        status: evidence.status,
        error: evidence.error,
        evidencePath,
      }),
    );
    process.exitCode = 1;
  }
}
