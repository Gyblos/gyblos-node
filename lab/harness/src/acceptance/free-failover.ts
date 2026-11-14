// Injects failures on actual native connections to prove free pre-send failover, post-send failover
// before any text (failover "safe", the default) and post-send stopping (failover "never").
// The second seller is independently signed, allowlisted only in this in-process index and never paid.
import { BUYER_FAILOVER } from '@gyblos/buyer/selection-config';
import { HTTP_STATUS } from '@gyblos/config';

import { acceptanceAssert } from './errors';
import { createFreeBuyer } from './free-buyer';
import { FREE_ACCEPTANCE_FAULTS } from './free-constants';
import { createFreeSeller } from './free-session';
import { pump } from './phases';
import type { AcceptanceSession } from './session';

export async function failoverCases(run: AcceptanceSession) {
  const second = await createFreeSeller(run.signal, run);
  try {
    acceptanceAssert(await second.host().publisher.tick());
    const before = await createFreeBuyer(
      run,
      [run, second],
      FREE_ACCEPTANCE_FAULTS.DIAL,
    );
    try {
      await before.answer();
      acceptanceAssert(
        before.dials.length === 2 && before.dials[0] !== before.dials[1],
      );
      acceptanceAssert(
        before.selections() === 2 && before.queryGenerations() === 0,
      );
    } finally {
      await before.close();
    }
    await pump(run, 1);
    await pump(second, 1);
    // The second seller's answer is lost after it generated: "safe" asks the other seller.
    const safe = await createFreeBuyer(
      run,
      [run, second],
      FREE_ACCEPTANCE_FAULTS.RESPONSE,
    );
    try {
      const generations = safe.generations();
      const response = await safe.chat();
      acceptanceAssert(response.status === HTTP_STATUS.ok);
      acceptanceAssert(
        safe.dials.length === 2 &&
          safe.dials[0] !== safe.dials[1] &&
          safe.selections() === 2,
      );
      acceptanceAssert(
        safe.generations() === generations + 2 && safe.queryGenerations() === 0,
      );
    } finally {
      await safe.close();
    }
    await pump(run, 1);
    await pump(second, 1);
    const after = await createFreeBuyer(
      run,
      [run, second],
      FREE_ACCEPTANCE_FAULTS.RESPONSE,
      undefined,
      BUYER_FAILOVER.NEVER,
    );
    try {
      const generations = after.generations();
      const response = await after.chat();
      acceptanceAssert(
        response.status === HTTP_STATUS.serviceUnavailable &&
          response.noRetry === 'false',
      );
      acceptanceAssert(after.dials.length === 1 && after.selections() === 1);
      acceptanceAssert(
        after.generations() === generations + 1 &&
          after.queryGenerations() === 0,
      );
    } finally {
      await after.close();
    }
    return 1;
  } finally {
    await second.close();
  }
}
