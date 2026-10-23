// Exposes one fixed compatibility probe; no raw IPC, filesystem or wallet API.
import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP } from './constants.js';
import { parseProbeResult } from './probe-model.js';

contextBridge.exposeInMainWorld('desktopProbe', {
  run: async () => parseProbeResult(await ipcRenderer.invoke(DESKTOP.CHANNEL)),
});
