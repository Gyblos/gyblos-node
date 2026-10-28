// How a free offer counts tokens. Recounted: the model's public tokenizer counts the prompt and every
// delivered text, as the buyer could. Declared: the engine's provider reports usage, which the seller
// bounds as the buyer verifies but cannot check; before usage exists the seller relies on UTF-8 bytes,
// which never number fewer than tokens. Pure.
import {
  CONTROL_METERING_MODES,
  type ControlMeteringMode,
} from '@gyblos/protocol/constants';
import type { EngineUsage, RecountTokenizer } from '@gyblos/protocol/engine';

import { FREE_METERING } from './constants';
import type { OfferMetering } from './engine-factory';

export interface FreeMeter {
  mode: ControlMeteringMode;
  // Never fewer than the prompt's tokens, so admission reserves enough against the context and caps.
  input(prompt: string): number;
  // Never more than the text's tokens, so a stream stops before it delivers past maxTokens.
  streamed(text: string): number;
  // What a stop reports as delivered: at least one token for non-empty text, never more than its bytes.
  delivered(text: string, maxTokens: number): number;
  // The final usage; the caller bounds it by maxTokens and the context as the buyer does.
  usage(
    text: string,
    reported: EngineUsage,
    inputTokens: number,
  ): { inputTokens: number; outputTokens: number };
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function recountedMeter(tokenizer: RecountTokenizer): FreeMeter {
  return {
    mode: CONTROL_METERING_MODES.RECOUNTED,
    input: (prompt) => tokenizer.input(prompt),
    streamed: (text) => tokenizer.count(text),
    // A normalising tokenizer could count more tokens than bytes; the stream already bounded maxTokens.
    delivered: (text) =>
      Math.min(Math.max(1, tokenizer.count(text)), bytes(text)),
    usage: (text, _reported, inputTokens) => ({
      inputTokens,
      outputTokens: tokenizer.count(text),
    }),
  };
}

export const DECLARED_METER: FreeMeter = Object.freeze({
  mode: CONTROL_METERING_MODES.DECLARED,
  input: (prompt: string) =>
    bytes(prompt) + FREE_METERING.declaredTemplateTokens,
  // Only the provider can count a streamed text; one token is all non-empty text is sure to hold.
  streamed: (text: string) => (text ? 1 : 0),
  delivered: (text: string, maxTokens: number) =>
    Math.min(bytes(text), maxTokens),
  usage: (_text: string, reported: EngineUsage) => ({
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
  }),
});

export async function offerMeter(metering: OfferMetering): Promise<FreeMeter> {
  return metering.mode === CONTROL_METERING_MODES.RECOUNTED
    ? recountedMeter(await metering.tokenizer())
    : DECLARED_METER;
}
