// Owns laboratory challenge; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { challengeGate } from '../src/challenge.js';

if (isMain(import.meta.url)) await challengeGate();
