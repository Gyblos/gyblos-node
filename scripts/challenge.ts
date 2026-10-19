import { challengeGate } from '@gyblos/gate/challenge';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await challengeGate();
