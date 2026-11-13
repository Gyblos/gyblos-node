// Admission for free requests running side by side. Each seller serves one request per buyer at a time, so
// selections take turns: each skips the sellers already serving another of this buyer's requests and
// reserves its winner until that request is done with it. With every candidate reserved the answer is
// busy (429, retry shortly), never a failure that would cool a healthy seller down.
import { FREE_BUYER_CODES } from './constants';
import { FreeBuyerError } from './free-chat';
import { FreeSelectionFailure } from './free-execution';

// No seller could take the request: none was eligible, or none of the free ones serves tools.
const unserved = (error: unknown) =>
  error instanceof FreeSelectionFailure ||
  (error instanceof FreeBuyerError &&
    error.code === FREE_BUYER_CODES.UNAVAILABLE);

// This request's turn, or its abort while it waits: a client that left does not hold a slot until the
// selection ahead of it ends.
function waitTurn(turn: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    });
  });
}

export function freeAdmission(limit: number) {
  let active = 0;
  const reserved = new Set<string>();
  let turn: Promise<void> = Promise.resolve();
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
      signal.throwIfAborted();
      // The next selection waits for the ones ahead and for this one, whether it runs or gives up waiting.
      const ahead = turn;
      let finished = () => {};
      turn = ahead.then(
        () =>
          new Promise<void>((resolve) => {
            finished = resolve;
          }),
      );
      return waitTurn(ahead, signal)
        .then(async () => {
          const busy = reserved.size > 0;
          try {
            const winner = await pick(new Set([...excluded, ...reserved]));
            reserved.add(winner.nodeId);
            return winner;
          } catch (error) {
            if (busy && unserved(error))
              throw new FreeBuyerError(FREE_BUYER_CODES.BUSY);
            throw error;
          }
        })
        .finally(() => {
          void ahead.then(() => finished());
        });
    },
    done(nodeId: string) {
      reserved.delete(nodeId);
    },
  };
}
