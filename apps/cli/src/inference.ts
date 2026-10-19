import { isMain } from '@gyblos/runtime';

import { main } from './inference/main.js';

export { main };
if (isMain(import.meta.url)) await main();
