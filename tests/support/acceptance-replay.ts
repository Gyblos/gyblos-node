// Exercises the real restart/replay phase with disposable stores and native loopback only.
// Other acceptance phases remain in the full suite; no product behavior or deadline is replaced.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { acceptQuote } from '@gyblos/lab-harness/acceptance/buyer';
import { ACCEPTANCE_MODES } from '@gyblos/lab-harness/acceptance/constants';
import { withdrawAndRestart } from '@gyblos/lab-harness/acceptance/phases';
import { createAcceptanceSession } from '@gyblos/lab-harness/acceptance/session';
import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';

export async function acceptanceReplay(t: TestContext, lost: boolean) {
  const run = await createAcceptanceSession(
    ACCEPTANCE_MODES.SYNTHETIC,
    t.signal,
  );
  let releaseReplay = () => {};
  t.after(async () => {
    releaseReplay();
    await run.close();
  });
  assert.equal(await run.host().publisher.tick(), true);
  await acceptQuote(run);

  let replayReady = () => {};
  const replayObserved = new Promise<void>((resolve) => {
    replayReady = resolve;
  });
  let heldReplay: Promise<void> | undefined;
  let restarts = 0;
  let observations = 0;
  let replayAccepted: boolean | undefined;
  let checked = false;
  let prematureFresh = false;
  let publications = 0;
  let connections = 0;
  const restart = run.restart.bind(run);
  t.mock.method(run, 'restart', async () => {
    const previous = run.state();
    await restart();
    assert.notEqual(run.state(), previous);
    restarts++;
    if (lost) {
      const empty = await createAcceptanceWorkspace();
      t.after(empty.close);
      const state = await buyerDiscoveryState(empty.environment);
      t.mock.method(run, 'state', () => state);
    }
    const state = run.state();
    const observe = state.observe.bind(state);
    t.mock.method(
      state,
      'observe',
      async (...args: Parameters<typeof observe>) => {
        const first = observations++ === 0;
        const accepted = await observe(...args);
        if (first) {
          replayAccepted = accepted;
          replayReady();
          await heldReplay;
          checked = true;
        }
        return accepted;
      },
    );
    const publisher = run.host().publisher;
    const tick = publisher.tick.bind(publisher);
    t.mock.method(publisher, 'tick', (...args: Parameters<typeof tick>) => {
      prematureFresh ||= !checked;
      publications++;
      return tick(...args);
    });
    const wire = run.host().wire;
    const connect = wire.client.bind(wire);
    t.mock.method(wire, 'client', (...args: Parameters<typeof connect>) => {
      prematureFresh ||= !checked;
      connections++;
      return connect(...args);
    });
  });
  return {
    check: () => withdrawAndRestart(run),
    snapshot: () => ({
      restarts,
      observations,
      replayAccepted,
      prematureFresh,
      publications,
      connections,
      checks: run.engine.generations(),
    }),
    pauseReplay() {
      heldReplay = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      return { observed: replayObserved, release: () => releaseReplay() };
    },
  };
}
