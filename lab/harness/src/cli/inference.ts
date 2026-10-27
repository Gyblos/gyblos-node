// CLI entry for the inference gate (GYB-GATE-0005); logic lives in inference/main.ts.
import { isMain } from '@gyblos/runtime';

import { main } from './inference/main';

export { main };

if (isMain(import.meta.url)) await main();
