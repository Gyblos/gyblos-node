// Exercises availability faults over one real control connection while keeping transport quotas unchanged.
// Background checks are explicit; control queries must not invoke even a failing engine.
import { SELLER_DISCOVERY, SELLER_READINESS } from '@gyblos/config';
import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import { READINESS_GENERATION } from '@gyblos/engine-ollama/constants';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { listed } from './buyer';
import { acceptanceAssert } from './errors';
import {
  FREE_ACCEPTANCE_CASES,
  type FreeAcceptanceCase,
} from './free-constants';
import { pump } from './phases';
import type { AcceptanceSession } from './session';

export async function freeAvailability(
  run: AcceptanceSession,
  record: (value: FreeAcceptanceCase) => void,
) {
  const wire = await run
    .host()
    .wire.client(run.identity.owner.address, run.clock.now);
  async function refusal(
    code:
      | typeof CONTROL_CODES.BUSY
      | typeof CONTROL_CODES.STALE
      | typeof CONTROL_CODES.EXPIRED,
  ) {
    const before = run.engine.attempts();
    let refused = false;
    try {
      await wire.client.getCatalog(run.signal);
    } catch (error) {
      refused = error instanceof ControlError && error.code === code;
    }
    acceptanceAssert(refused && run.engine.attempts() === before);
  }
  async function recovered() {
    const before = run.engine.attempts();
    await wire.client.getCatalog(run.signal);
    acceptanceAssert(run.engine.attempts() === before);
  }
  try {
    const sequence = run.host().control.records.current().record.sequence;
    const release = run.engine.holdNext();
    const work = run.host().observation.engine.generate({
      ...READINESS_GENERATION,
      signal: run.signal,
    });
    void work.catch(() => {});
    try {
      acceptanceAssert(run.host().observation.readiness().busy);
      acceptanceAssert(!(await run.host().observation.tick()));
      await refusal(CONTROL_CODES.BUSY);
      await run.host().publisher.tick();
      acceptanceAssert((await listed(run)).sellers.length === 0);
    } finally {
      release();
      await work;
    }
    acceptanceAssert(await run.host().publisher.tick());
    acceptanceAssert(
      run.host().control.records.current().record.sequence > sequence,
    );
    await recovered();
    record(FREE_ACCEPTANCE_CASES.BUSY_RECOVERY);
    run.engine.fail(true);
    await pump(run, OFFER_LIFETIME_MS - SELLER_READINESS.renewBeforeMs);
    acceptanceAssert(
      run.host().observation.readiness().validUntil <= run.clock.now(),
    );
    await refusal(CONTROL_CODES.STALE);
    acceptanceAssert((await listed(run)).sellers.length === 0);
    run.engine.fail(false);
    await pump(run, SELLER_DISCOVERY.maxRetryMs);
    await recovered();
    record(FREE_ACCEPTANCE_CASES.ENGINE_RECOVERY);
    await run.clock.advance(
      run.host().observation.readiness().validUntil - run.clock.now(),
    );
    await refusal(CONTROL_CODES.EXPIRED);
    acceptanceAssert(!(await run.host().publisher.tick()));
    acceptanceAssert((await listed(run)).sellers.length === 0);
    await pump(run, SELLER_DISCOVERY.maxRetryMs);
    await recovered();
    record(FREE_ACCEPTANCE_CASES.EXPIRY_RECOVERY);
  } finally {
    await wire.close();
  }
}
