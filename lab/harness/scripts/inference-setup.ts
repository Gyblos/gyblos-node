import { isMain } from '@gyblos/runtime';

import { setupInferenceGate } from '../src/inference-setup.js';

if (isMain(import.meta.url)) await setupInferenceGate();
