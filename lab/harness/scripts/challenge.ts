import { challengeGate } from '@gyblos/lab-harness/challenge';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await challengeGate();
