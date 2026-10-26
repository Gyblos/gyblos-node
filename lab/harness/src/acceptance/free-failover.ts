// Injects failures on actual native connections to prove free pre-send failover and post-send stopping.
// The second seller is independently signed, allowlisted only in this in-process index and never paid.
import { HTTP_STATUS } from '@gyblos/config';

import { acceptanceAssert } from './errors.js';
import { createFreeBuyer } from './free-buyer.js';
import { FREE_ACCEPTANCE_FAULTS } from './free-constants.js';
import { createFreeSeller } from './free-session.js';
import { pump } from './phases.js';
import type { AcceptanceSession } from './session.js';

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
    const after = await createFreeBuyer(
      run,
      [run, second],
      FREE_ACCEPTANCE_FAULTS.RESPONSE,
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
