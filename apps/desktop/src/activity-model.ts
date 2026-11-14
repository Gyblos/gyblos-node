// Validates the read-only activity bridge; contains no payment identifiers or chat text.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import type { createPaypalSession } from '@gyblos/node/paypal-session';

import { DESKTOP_ACTIVITY } from './constants';

export type SessionActivity = NonNullable<
  ReturnType<Awaited<ReturnType<typeof createPaypalSession>>['activity']>
>;
export type ActivityEntry = SessionActivity & {
  firstObservedAt: number;
  updatedAt: number;
};
export type ActivityResult = {
  available: boolean;
  currentSessionId: string | null;
  sessions: ActivityEntry[];
};
export function unavailableActivity(): ActivityResult {
  return { available: false, currentSessionId: null, sessions: [] };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
export function activityId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseEntry(value: unknown): ActivityEntry | null {
  const item = object(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !==
      'agentCents,agentCount,capturedCents,chatCents,chatCount,firstObservedAt,id,limitCents,needsReview,phase,recordedCents,unconfirmedCents,updatedAt'
  )
    return null;
  const phase = Object.values(PAYPAL_SESSION_PHASE).find(
    (entry) => entry === item.phase,
  );
  if (
    !activityId(item.id) ||
    !phase ||
    typeof item.needsReview !== 'boolean' ||
    !amount(item.limitCents) ||
    item.limitCents === 0 ||
    !amount(item.recordedCents) ||
    item.recordedCents > item.limitCents ||
    !amount(item.chatCount) ||
    !amount(item.agentCount) ||
    !amount(item.chatCents) ||
    !amount(item.agentCents) ||
    !amount(item.unconfirmedCents) ||
    item.chatCents + item.agentCents + item.unconfirmedCents !==
      item.recordedCents ||
    !amount(item.firstObservedAt) ||
    !amount(item.updatedAt) ||
    item.updatedAt < item.firstObservedAt ||
    !Number.isFinite(new Date(item.firstObservedAt).getTime()) ||
    !Number.isFinite(new Date(item.updatedAt).getTime()) ||
    (item.capturedCents !== null &&
      (!amount(item.capturedCents) ||
        phase !== PAYPAL_SESSION_PHASE.COMPLETED ||
        item.needsReview ||
        item.capturedCents !== item.recordedCents))
  )
    return null;
  return {
    id: item.id,
    phase,
    limitCents: item.limitCents,
    recordedCents: item.recordedCents,
    chatCount: item.chatCount,
    agentCount: item.agentCount,
    chatCents: item.chatCents,
    agentCents: item.agentCents,
    unconfirmedCents: item.unconfirmedCents,
    capturedCents: item.capturedCents,
    needsReview: item.needsReview,
    firstObservedAt: item.firstObservedAt,
    updatedAt: item.updatedAt,
  };
}
export function parseActivityResult(value: unknown): ActivityResult {
  const item = object(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !==
      'available,currentSessionId,sessions' ||
    typeof item.available !== 'boolean' ||
    (item.currentSessionId !== null && !activityId(item.currentSessionId)) ||
    !Array.isArray(item.sessions) ||
    item.sessions.length > DESKTOP_ACTIVITY.MAX_SESSIONS
  )
    return unavailableActivity();
  const sessions: ActivityEntry[] = [];
  for (const value of item.sessions) {
    const entry = parseEntry(value);
    if (!entry || sessions.some((row) => row.id === entry.id))
      return unavailableActivity();
    sessions.push(entry);
  }
  if (
    item.currentSessionId !== null &&
    !sessions.some((entry) => entry.id === item.currentSessionId)
  )
    return unavailableActivity();
  return {
    available: item.available,
    currentSessionId: item.currentSessionId,
    sessions,
  };
}
