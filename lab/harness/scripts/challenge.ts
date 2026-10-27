// Script entry for the unpaid-challenge gate: runs challengeGate() when executed directly.
import { isMain } from '@gyblos/runtime';

import { challengeGate } from '../src/challenge';

if (isMain(import.meta.url)) await challengeGate();
