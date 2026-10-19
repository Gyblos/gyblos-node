import { setupInferenceGate } from '@gyblos/gate/inference-setup';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await setupInferenceGate();
