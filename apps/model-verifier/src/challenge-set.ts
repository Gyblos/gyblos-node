import { createHash } from 'node:crypto';

import { canonicalJson } from '@gyblos/protocol';

export interface ChallengeRule {
  maxTokens: number;
  checksPerAnswer: number;
  topLogprobs: number;
  minProbabilityPpm: number;
  honestRatePpm: number;
  falsePositivePpm: number;
  minimumChecks: number;
}
export interface ChallengeSet {
  id: string;
  version: number;
  rule: ChallengeRule;
  prompts: readonly string[];
}

export const CHALLENGE_SET: ChallengeSet = {
  id: 'gyblos-text',
  version: 1,
  rule: {
    maxTokens: 200,
    checksPerAnswer: 24,
    topLogprobs: 20,
    minProbabilityPpm: 1_000,
    honestRatePpm: 120_000,
    falsePositivePpm: 100,
    minimumChecks: 480,
  },
  prompts: [
    'Explain in three sentences how a hash map works.',
    'Write a Python function that returns the n-th Fibonacci number iteratively.',
    '¿Cuáles son tres consejos para dormir mejor? Responde en español.',
    'Summarize the causes of the French Revolution in one paragraph.',
    'Write a short email asking a colleague to review a pull request.',
    'Return a JSON object with fields name, age and city for a fictional person.',
    'What is the difference between TCP and UDP?',
    'Write a haiku about autumn rain.',
    'Explain what a closure is in JavaScript with a small example.',
    'List five common uses of the Linux command grep.',
    'Describe the water cycle for a ten-year-old.',
    'Write a SQL query that counts orders per customer in a table named orders.',
    'Explica qué es la inflación en dos párrafos cortos.',
    'Give three arguments for and against remote work.',
    'Translate to French: The meeting has been moved to Thursday afternoon.',
    'What does the Rust borrow checker prevent? Answer briefly.',
    'Write a bash one-liner that finds the ten largest files in a directory.',
    'Describe how photosynthesis works.',
    'Write a limerick about a cat who learns to code.',
    'Explain the CAP theorem in simple words.',
    'Write a TypeScript interface for a blog post with tags and an author.',
    'What are the main differences between a list and a tuple in Python?',
    'Dame una receta corta de guacamole.',
    'Explain why the sky is blue.',
    'Write a regular expression that matches an ISO date like 2024-05-17 and explain it.',
    'How does public-key cryptography let two people share a secret?',
    'Write a short story opening about a lighthouse keeper, in four sentences.',
    'What is gradient descent? Keep it under 120 words.',
    'Compare Git merge and Git rebase.',
    'Explain what an index does in a relational database.',
  ],
};

export function challengeSetDigest(set: ChallengeSet): string {
  return createHash('sha256').update(canonicalJson(set)).digest('hex');
}
