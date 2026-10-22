// Owns laboratory failures; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { failureGate } from '../src/failures.js';

if (isMain(import.meta.url)) await failureGate();
