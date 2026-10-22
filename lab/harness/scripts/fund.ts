import { isMain } from '@gyblos/runtime';

import { fundGate } from '../src/fund.js';

if (isMain(import.meta.url)) await fundGate();
