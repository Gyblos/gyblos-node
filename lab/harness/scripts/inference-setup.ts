// Script entry that downloads the pinned tokenizer and Ollama model: runs setupInferenceGate().
import { isMain } from '@gyblos/runtime';

import { setupInferenceGate } from '../src/inference-setup';

if (isMain(import.meta.url)) await setupInferenceGate();
