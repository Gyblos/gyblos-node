// Script entry for devnet funding: runs fundGate() when executed directly (pass --test-mint for SPL).
import { isMain } from '@gyblos/runtime';

import { fundGate } from '../src/fund';

if (isMain(import.meta.url)) await fundGate();
