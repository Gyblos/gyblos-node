// Script entry for the F1/F2 failure gate: runs failureGate() when executed directly.
import { isMain } from '@gyblos/runtime';

import { failureGate } from '../src/failures';

export { failureGate };

if (isMain(import.meta.url)) await failureGate();
