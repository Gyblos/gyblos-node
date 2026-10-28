// CLI entry for the exact-scheme gate against public facilitators; logic lives in exact/main.ts.
import { isMain } from '@gyblos/runtime';

import { main } from './exact/main';

export { main };

if (isMain(import.meta.url)) await main();
