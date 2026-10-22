// Owns synthetic cases in node; it must not know lab orchestration or CLI processes.
import { randomUUID } from 'node:crypto';

import { INFERENCE_CASES } from './constants.js';

export function createCases(
  debugRequestId: string,
  failureRequestId: string,
  underchargeRequestId?: string,
) {
  return [
    {
      name: INFERENCE_CASES.HONEST_1,
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences how rain forms.',
    },
    {
      name: INFERENCE_CASES.HONEST_2,
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences why plants need sunlight.',
    },
    {
      name: INFERENCE_CASES.HONEST_3,
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences how a bicycle moves.',
    },
    {
      name: INFERENCE_CASES.OVERCHARGE,
      requestId: debugRequestId,
      prompt: 'Explain in four sentences how a seed becomes a tree.',
    },
    ...(underchargeRequestId === undefined
      ? []
      : [
          {
            name: INFERENCE_CASES.UNDERCHARGE,
            requestId: underchargeRequestId,
            prompt: 'Explain in four sentences how a seed becomes a tree.',
          },
        ]),
    {
      name: INFERENCE_CASES.ENGINE_INTERRUPTED,
      requestId: failureRequestId,
      prompt: 'Describe in detail the water cycle in ten numbered paragraphs.',
    },
  ];
}
