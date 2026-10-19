import { fundGate } from '@gyblos/gate/fund';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await fundGate();
