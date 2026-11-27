export const AGENT_REPLAY = {
  sellerCounts: [1, 2, 3],
  loopTurns: 10,
  pace: { firstTokenMs: 400, tokenMs: 15, tokens: 60 },
  caps: { dailyTokenCap: 10_000_000, perBuyerCap: 1_000_000 },
  maxTokens: 256,
  turnChars: 600,
  runMs: 15 * 60_000,
  percentiles: [50, 95],
  tagPrefix: 'replay-request-',
  outFile: 'agent-replay.jsonl',
  prompts: {
    main: 'You are a coding agent. Use tools when needed.',
    title: 'Generate a short title for this conversation.',
    summary: 'Summarize this conversation in one paragraph.',
    task: 'Fix the failing test in the parser module.',
    tool: 'Tool result: 3 files changed, tests pass.',
  },
} as const;

export const REPLAY_ROLES = {
  TITLE: 'title',
  SUMMARY: 'summary',
  MAIN: 'main',
} as const;
export type ReplayRole = (typeof REPLAY_ROLES)[keyof typeof REPLAY_ROLES];
