import { setupInferenceGate } from '@gyblos/lab-harness/inference-setup';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) await setupInferenceGate();
