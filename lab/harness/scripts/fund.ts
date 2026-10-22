import { fundGate } from '@gyblos/lab-harness/fund';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await fundGate();
