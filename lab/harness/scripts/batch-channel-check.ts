// Script entry for the batch-settlement channel check: runs batchChannelCheck() when executed
// directly (pass --devnet only for a founder-approved devnet run). An unfunded devnet funder exits 2.
import { isMain } from '@gyblos/runtime';

import { batchChannelCheck } from '../src/batch-channel/check';
import { FunderNeedsSolError } from '../src/batch-channel/devnet';

if (isMain(import.meta.url))
  await batchChannelCheck(process.argv.slice(2), process.env).catch(
    (error: unknown) => {
      if (!(error instanceof FunderNeedsSolError)) throw error;
      console.error(error.message);
      process.exitCode = error.exitCode;
    },
  );
