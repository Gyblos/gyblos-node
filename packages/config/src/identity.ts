// Owns the 8004 agent-registry deployment Gyblos targets (devnet only); an operator may point at another instance.
// It must not know account layouts, instruction encoding or sponsorship policy.
export const IDENTITY_REGISTRY_DEVNET = {
  program: '8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C',
  rootConfig: 'GGQfKNpXq8HchNxecLfXi8D7xz9PDppdPAPgr5Fx4Nvd',
  registryConfig: 'Djy4TKPvFyEumcVTDCqJUHWErKqcaeRj4ULWwaPkedor',
  collection: '6CTyGPcn8dMwKEqgtvx2XCpkGUd7uqCVK6937RSM5bhA',
} as const;
