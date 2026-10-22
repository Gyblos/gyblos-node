// Owns laboratory exact; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { main } from './exact/main.js';

export { main };

if (isMain(import.meta.url)) await main();
