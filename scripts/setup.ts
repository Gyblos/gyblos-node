import { setupGate } from '@gyblos/gate/setup';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await setupGate();
