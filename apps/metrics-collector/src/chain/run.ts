// Owns the state one scheduled chain read carries through its phases, and reading one transaction in
// full (the call the index spends most carefully).
import type { CollectorDatabase } from '../d1-client';
import { decodeTransaction } from './decode';
import type { ChainEndpoints } from './endpoints';
import type { ChainCursorState } from './writes';

export interface ChainRun {
  orm: CollectorDatabase;
  rpc: ChainEndpoints;
  now: number;
  cursor: ChainCursorState;
  // Channels a read transaction named: their accounts are read at the end.
  touched: Set<string>;
  listed: number;
  read: number;
  followed: number;
  flooded: number;
  undecodable: number;
}

export async function readTransaction(run: ChainRun, signature: string) {
  const tx = decodeTransaction(await run.rpc.transaction(signature));
  run.read += 1;
  run.undecodable += tx.undecodable;
  for (const instruction of tx.instructions)
    run.touched.add(instruction.channel);
  return tx;
}
