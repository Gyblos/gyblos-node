// Owns laboratory inference; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { main } from './inference/main.js';

export { main };

if (isMain(import.meta.url)) await main();
