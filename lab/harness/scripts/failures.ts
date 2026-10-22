import { failureGate } from '@gyblos/lab-harness/failures';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await failureGate();
