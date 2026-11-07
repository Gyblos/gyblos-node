// Preview-only reasoning selection from the shared catalog; never enables live engine options.
import {
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import { MODEL_CATALOG, type ReasoningSupport } from '@gyblos/protocol/models';

import { PAYMENT_METHOD, type PaymentMethod } from '../paypal-model';
import type { ChatModel } from './model-types';

export type ReasoningSelection = { modelId: string; level: ReasoningLevel };
export function chatReasoningChoice(
  model: ChatModel,
  method: PaymentMethod,
  selection: ReasoningSelection | null,
) {
  if (method !== PAYMENT_METHOD.USDC || !model.catalogId) return null;
  const support = MODEL_CATALOG.find(
    (item) => item.id === model.catalogId,
  )?.reasoning;
  if (!support || support.levels.length < 2) return null;
  const selected =
    selection?.modelId === model.id ? selection.level : undefined;
  return {
    support,
    value:
      selected && support.levels.includes(selected)
        ? selected
        : support.defaultReasoning,
  };
}
export function reasoningLabel(
  support: Readonly<ReasoningSupport> | null,
  value: ReasoningLevel,
) {
  if (
    support?.levels.includes(REASONING_LEVELS.OFF) &&
    value === REASONING_LEVELS.HIGH
  )
    return 'On';
  switch (value) {
    case REASONING_LEVELS.OFF:
      return 'Off';
    case REASONING_LEVELS.LOW:
      return 'Low';
    case REASONING_LEVELS.MEDIUM:
      return 'Medium';
    case REASONING_LEVELS.HIGH:
      return 'High';
  }
}
