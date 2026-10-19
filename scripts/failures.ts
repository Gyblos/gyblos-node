import { failureGate } from '@gyblos/gate/failures';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await failureGate();
