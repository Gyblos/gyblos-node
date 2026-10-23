// File names for the Iroh buyer/seller roles under .local/p2p. Limits, ports and policy values
// live with their owners (transport.ts, hosts.ts, core, payments-x402, node and buyer constants).
export const P2P = {
  root: '.local/p2p',
  roleConfig: 'role.json',
  trustFilename: 'trust.json',
  statusFilename: 'status.json',
  traceFilename: 'traces.json',
  metricsFilename: 'transport.jsonl',
  measurementsFilename: 'measurements.jsonl',
  buyerLockFilename: 'buyer.lock',
  recoveryLockFilename: 'recovery.lock',
  staleLockJournalFilename: 'stale-locks.jsonl',
  journalFilename: 'authorization.json',
  reconciliationsFilename: 'reconciliations.json',
  callsFilename: 'calls.json',
  offerFilename: 'offer.json',
  nodeKeyFilename: 'node.key',
  keys: {
    buyer: 'buyer.json',
    owner: 'owner.json',
    authorizer: 'authorizer.json',
    facilitator: 'facilitator.json',
  },
} as const;
