// Private test-process envelopes and sanitized state; never transport keys or inference content.
import assert from 'node:assert/strict';

import {
  parseUptoWithdrawalAttempt,
  type UptoWithdrawalAttempt,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  type PaymentChannelState,
} from '@gyblos/protocol/constants';
import type { PaymentTerms } from '@gyblos/protocol/payment';

import {
  CRASH_ACTIONS,
  CRASH_CUTS,
  type CrashAction,
  type CrashCut,
} from './channel-crash-constants';
import { crashObject } from './channel-crash-rpc';

export interface CrashInput {
  root: string;
  now: number;
  terms: PaymentTerms;
  action: CrashAction;
  cut?: CrashCut;
  expectedAtomic: string;
}
export interface CrashState {
  channelId: string | null;
  state: PaymentChannelState;
  chargedAtomic: string | null;
  withdrawal?: UptoWithdrawalAttempt;
}
export interface CrashProof {
  chargedAtomic: string | null;
  refundedAtomic: string | null;
}
export interface CrashReply {
  runtimeBlockedBefore: boolean;
  entry: CrashState | null;
  financial: CrashProof | null;
  runtimeBlocked: boolean;
  startupBlocked: boolean;
}

export function parseCrashInput(raw: unknown): CrashInput {
  const value = crashObject(raw);
  assert.ok(
    typeof value.root === 'string' &&
      typeof value.now === 'number' &&
      Number.isSafeInteger(value.now),
  );
  const action = Object.values(CRASH_ACTIONS).find(
    (item) => item === value.action,
  );
  const cut = Object.values(CRASH_CUTS).find((item) => item === value.cut);
  assert.ok(action && (value.cut === undefined || cut));
  const terms = crashObject(value.terms);
  assert.ok(
    typeof value.expectedAtomic === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(value.expectedAtomic),
  );
  const text = (key: string) => {
    const found = terms[key];
    assert.ok(typeof found === 'string');
    return found;
  };
  assert.ok(
    typeof terms.protocolFeeBps === 'number' &&
      typeof terms.expiresAt === 'number',
  );
  return {
    root: value.root,
    now: value.now,
    action,
    expectedAtomic: value.expectedAtomic,
    ...(cut ? { cut } : {}),
    terms: {
      network: text('network'),
      mint: text('mint'),
      treasury: text('treasury'),
      maxAtomic: text('maxAtomic'),
      buyer: text('buyer'),
      payTo: text('payTo'),
      feePayer: text('feePayer'),
      authorizer: text('authorizer'),
      requestDigest: text('requestDigest'),
      protocolFeeBps: terms.protocolFeeBps,
      expiresAt: terms.expiresAt,
    },
  };
}

export function parseCrashState(raw: unknown): CrashState | null {
  if (raw === null) return null;
  const value = crashObject(raw);
  assert.ok(value.channelId === null || typeof value.channelId === 'string');
  assert.ok(
    value.chargedAtomic === null || typeof value.chargedAtomic === 'string',
  );
  const state = Object.values(PAYMENT_CHANNEL_STATES).find(
    (item) => item === value.state,
  );
  assert.ok(state);
  return {
    channelId: value.channelId,
    state,
    chargedAtomic: value.chargedAtomic,
    ...(value.withdrawal
      ? { withdrawal: parseUptoWithdrawalAttempt(value.withdrawal) }
      : {}),
  };
}

export function parseCrashReply(raw: unknown): CrashReply {
  const value = crashObject(raw);
  assert.ok(
    typeof value.runtimeBlockedBefore === 'boolean' &&
      typeof value.runtimeBlocked === 'boolean' &&
      typeof value.startupBlocked === 'boolean',
  );
  const proof = value.financial === null ? null : crashObject(value.financial);
  assert.ok(
    proof === null ||
      ((proof.chargedAtomic === null ||
        typeof proof.chargedAtomic === 'string') &&
        (proof.refundedAtomic === null ||
          typeof proof.refundedAtomic === 'string')),
  );
  return {
    runtimeBlockedBefore: value.runtimeBlockedBefore,
    entry: parseCrashState(value.entry),
    financial: proof
      ? {
          chargedAtomic:
            proof.chargedAtomic === null ? null : String(proof.chargedAtomic),
          refundedAtomic:
            proof.refundedAtomic === null ? null : String(proof.refundedAtomic),
        }
      : null,
    runtimeBlocked: value.runtimeBlocked,
    startupBlocked: value.startupBlocked,
  };
}
