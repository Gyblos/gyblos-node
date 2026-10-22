// Owns laboratory fund; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { fundGate } from '../src/fund.js';

if (isMain(import.meta.url)) await fundGate();
