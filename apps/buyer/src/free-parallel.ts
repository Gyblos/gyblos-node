// Admission for free requests running side by side. Each seller serves one request per buyer at a time, so
// selections take turns: each skips the sellers already serving another of this buyer's requests and
// reserves its winner until that request is done with it. With every candidate reserved the answer is
// busy (429, retry shortly), never a failure that would cool a healthy seller down.
import { FREE_BUYER_CODES } from './constants';
import { FreeBuyerError } from './free-chat';
import { FreeSelectionFailure } from './free-execution';

export function freeAdmission(limit: number) {
  let active = 0;
  const reserved = new Set<string>();
  let turn: Promise<unknown> = Promise.resolve();
  return {
    enter() {
      if (active >= limit) throw new FreeBuyerError(FREE_BUYER_CODES.BUSY);
      active++;
      let open = true;
      return () => {
        if (open) active--;
        open = false;
      };
    },
    select<Winner extends { nodeId: string }>(
      excluded: ReadonlySet<string>,
      signal: AbortSignal,
      pick: (skip: ReadonlySet<string>) => Promise<Winner>,
    ): Promise<Winner> {
      const run = turn.then(async () => {
        signal.throwIfAborted();
        const busy = reserved.size > 0;
        try {
          const winner = await pick(new Set([...excluded, ...reserved]));
          reserved.add(winner.nodeId);
          return winner;
        } catch (error) {
          if (busy && error instanceof FreeSelectionFailure)
            throw new FreeBuyerError(FREE_BUYER_CODES.BUSY);
          throw error;
        }
      });
      turn = run.catch(() => undefined);
      return run;
    },
    done(nodeId: string) {
      reserved.delete(nodeId);
    },
  };
}
