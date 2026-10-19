import { randomUUID } from 'node:crypto';

export function createCases(
  debugRequestId: string,
  failureRequestId: string,
  underchargeRequestId?: string,
) {
  return [
    {
      name: 'honest-1',
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences how rain forms.',
    },
    {
      name: 'honest-2',
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences why plants need sunlight.',
    },
    {
      name: 'honest-3',
      requestId: randomUUID(),
      prompt: 'Explain in three short sentences how a bicycle moves.',
    },
    {
      name: 'overcharge',
      requestId: debugRequestId,
      prompt: 'Explain in four sentences how a seed becomes a tree.',
    },
    ...(underchargeRequestId === undefined
      ? []
      : [
          {
            name: 'undercharge',
            requestId: underchargeRequestId,
            prompt: 'Explain in four sentences how a seed becomes a tree.',
          },
        ]),
    {
      name: 'engine-interrupted',
      requestId: failureRequestId,
      prompt: 'Describe in detail the water cycle in ten numbered paragraphs.',
    },
  ];
}
