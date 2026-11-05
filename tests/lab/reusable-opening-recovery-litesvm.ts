// Exchanges only synthetic fixture data with an isolated local LiteSVM process.
// The independent observer and finality guarantees here are simulated by the test harness.
import { readFileSync } from 'node:fs';

import {
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  getBase64Encoder,
} from '@solana/kit';

import { CHANNEL_PROGRAM, DEVNET, PROTOCOL_FEE } from '@gyblos/config';
import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import { createReusableOpening } from '@gyblos/payments-upto/reusable-opening';

async function main() {
  const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (!input || typeof input !== 'object') throw new Error('Invalid input');
  const fields = [
    'phase',
    'home',
    'seller',
    'feePayer',
    'treasury',
    'mint',
    'tokenProgram',
    'blockhash',
    'slot',
  ];
  const values = fields.map((field) => Reflect.get(input, field));
  if (!values.every((value) => typeof value === 'string'))
    throw new Error('Invalid input');
  const [
    phase,
    home,
    seller,
    feePayer,
    treasury,
    mint,
    tokenProgram,
    blockhash,
    slot,
  ] = values;
  const secret: unknown = Reflect.get(input, 'secret');
  if (
    typeof phase !== 'string' ||
    typeof home !== 'string' ||
    typeof seller !== 'string' ||
    typeof feePayer !== 'string' ||
    typeof treasury !== 'string' ||
    typeof mint !== 'string' ||
    typeof tokenProgram !== 'string' ||
    typeof blockhash !== 'string' ||
    typeof slot !== 'string' ||
    !Array.isArray(secret) ||
    secret.length !== 64
  )
    throw new Error('Invalid input');
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(secret));
  let journal = await openReusableJournal({
    environment: { GYBLOS_HOME: home },
  });
  try {
    if (phase === 'open') {
      const network = DEVNET;
      const protocolFeeBps = PROTOCOL_FEE.bps;
      const options = {
        journal,
        signer,
        network,
        mint,
        sellerNodeId: 'ab'.repeat(32),
        payTo: seller,
        feePayer,
        treasury,
        protocolFeeBps,
        depositAtomic: '1000',
        openSlot: slot,
        lastValidBlockHeight: '1000',
        tokenProgram,
        gracePeriod: 3600,
        recentBlockhash: blockhash,
        policy: {
          network,
          mint,
          treasury,
          protocolFeeBps,
          maxDepositAtomic: '1000',
        },
      };
      const result = await createReusableOpening(options);
      const saved = await journal.get(result.payload.channelId);
      if (
        !saved ||
        saved.authorizedAtomic !== '0' ||
        saved.vouchers.length !== 0 ||
        'voucher' in result.payload
      )
        throw new Error('Unexpected authorization');
      process.stdout.write(
        JSON.stringify({
          channelId: result.payload.channelId,
          transaction: Array.from(
            getBase64Encoder().encode(result.payload.openTransaction),
          ),
          authorizedAtomic: saved.authorizedAtomic,
          voucherCount: saved.vouchers.length,
        }),
      );
      return;
    }
    const channel: unknown = Reflect.get(input, 'channel');
    const tip: unknown = Reflect.get(input, 'tip');
    if (phase === 'confirm') {
      const observedSalt: unknown = Reflect.get(input, 'observedSalt');
      const observedDeposit: unknown = Reflect.get(input, 'observedDeposit');
      const observedSlot: unknown = Reflect.get(input, 'observedSlot');
      const observedGrace: unknown = Reflect.get(input, 'observedGrace');
      const distribution: unknown = Reflect.get(input, 'distribution');
      const observedSettled: unknown = Reflect.get(input, 'observedSettled');
      const observedPaid: unknown = Reflect.get(input, 'observedPaid');
      const charged: unknown = Reflect.get(input, 'charged');
      if (
        typeof channel !== 'string' ||
        typeof tip !== 'string' ||
        typeof observedSalt !== 'string' ||
        typeof observedDeposit !== 'string' ||
        typeof observedSlot !== 'string' ||
        typeof observedGrace !== 'number' ||
        !Array.isArray(distribution) ||
        typeof observedSettled !== 'string' ||
        typeof observedPaid !== 'string' ||
        typeof charged !== 'boolean'
      )
        throw new Error('Invalid open evidence');
      const read = async () => ({
        channelId: channel,
        network: DEVNET,
        programOwner: CHANNEL_PROGRAM,
        payer: signer.address,
        payee: feePayer,
        rentPayer: feePayer,
        authorizedSigner: signer.address,
        mint,
        tokenProgram,
        salt: observedSalt,
        openSlot: observedSlot,
        gracePeriod: observedGrace,
        depositAtomic: observedDeposit,
        distributionHash: Buffer.from(distribution).toString('hex'),
        state: 'open',
        finalized: true,
        contextSlot: tip,
        finalizedTipSlot: tip,
        settledAtomic: observedSettled,
        paidAtomic: observedPaid,
      });
      await journal.confirmOpen(channel, read);
      const signatures: number[][] = [];
      if (charged) {
        const first = await journal.issueVoucher(
          channel,
          '11'.repeat(32),
          '56',
          signer,
          read,
        );
        const second = await journal.issueVoucher(
          channel,
          '22'.repeat(32),
          '200',
          signer,
          read,
        );
        signatures.push(Array.from(getBase58Encoder().encode(first.signature)));
        signatures.push(
          Array.from(getBase58Encoder().encode(second.signature)),
        );
      }
      await journal.close();
      journal = await openReusableJournal({
        environment: { GYBLOS_HOME: home },
      });
      const reopened = await journal.get(channel);
      if (
        reopened?.status !== 'ready' ||
        reopened.vouchers.length !== (charged ? 2 : 0)
      )
        throw new Error('Confirmation failed');
      process.stdout.write(JSON.stringify({ status: 'ready', signatures }));
      return;
    }
    if (phase !== 'recover') throw new Error('Unknown phase');
    const refund: unknown = Reflect.get(input, 'refund');
    const deposited: unknown = Reflect.get(input, 'deposited');
    const closed: unknown = Reflect.get(input, 'closed');
    const escrow: unknown = Reflect.get(input, 'escrow');
    const sellerReceived: unknown = Reflect.get(input, 'sellerReceived');
    const treasuryReceived: unknown = Reflect.get(input, 'treasuryReceived');
    const programResidual: unknown = Reflect.get(input, 'programResidual');
    const redirected: unknown = Reflect.get(input, 'redirected');
    const escrowAccount: unknown = Reflect.get(input, 'escrowAccount');
    const programTreasuryOwner: unknown = Reflect.get(
      input,
      'programTreasuryOwner',
    );
    const settled: unknown = Reflect.get(input, 'settled');
    if (
      typeof channel !== 'string' ||
      typeof tip !== 'string' ||
      typeof refund !== 'string' ||
      typeof deposited !== 'string' ||
      typeof closed !== 'boolean' ||
      typeof escrow !== 'string' ||
      typeof sellerReceived !== 'string' ||
      typeof treasuryReceived !== 'string' ||
      typeof programResidual !== 'string' ||
      typeof redirected !== 'string' ||
      typeof escrowAccount !== 'string' ||
      typeof programTreasuryOwner !== 'string' ||
      typeof settled !== 'string'
    )
      throw new Error('Invalid evidence');
    await journal.recoverClosedChannel(
      channel,
      async (terms) => ({
        finalized: true,
        network: DEVNET,
        program: CHANNEL_PROGRAM,
        channelId: channel,
        mint,
        buyer: signer.address,
        payTo: seller,
        treasury,
        historyComplete: true,
        historyFromSlot: slot,
        historyThroughSlot: tip,
        finalizedTipSlot: tip,
        channelClosed: closed,
        escrowBalanceAtomic: escrow,
        escrowTokenAccount: escrowAccount,
        programTreasuryOwner,
        depositedAtomic: deposited,
        settledAtomic: settled,
        sellerReceivedAtomic: sellerReceived,
        treasuryReceivedAtomic: treasuryReceived,
        programResidualAtomic: programResidual,
        buyerRefundAtomic: refund,
        buyerRefundOwner: terms.buyer,
        redirectedAtomic: redirected,
        buyerRefundRedirectedAtomic: redirected,
        sellerRedirectedAtomic: '0',
        treasuryRedirectedAtomic: '0',
      }),
      signer,
      { programTreasuryOwner },
    );
    await journal.close();
    journal = await openReusableJournal({ environment: { GYBLOS_HOME: home } });
    const saved = await journal.get(channel);
    if (
      !saved ||
      saved.status !== (redirected === '0' ? 'closed' : 'closed-redirected') ||
      saved.closure?.buyerRefundAtomic !== refund ||
      saved.closure.buyerRefundRedirectedAtomic !== redirected
    )
      throw new Error('Recovery failed');
    process.stdout.write(
      JSON.stringify({
        status: saved.status,
        refund: saved.closure.buyerRefundAtomic,
        redirected: saved.closure.buyerRefundRedirectedAtomic,
      }),
    );
  } finally {
    await journal.close();
  }
}
main().catch(() => {
  process.stderr.write('Synthetic recovery failed.\n');
  process.exitCode = 1;
});
