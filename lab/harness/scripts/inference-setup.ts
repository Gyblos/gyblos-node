// Owns laboratory inference setup; product code must not depend on this module.
import { isMain } from '@gyblos/runtime';

import { setupInferenceGate } from '../src/inference-setup.js';

if (isMain(import.meta.url)) await setupInferenceGate();
