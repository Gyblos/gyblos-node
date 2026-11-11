// Pure native-window configuration and allowlisted platform metadata, never window-control IPC.
import type { BrowserWindowConstructorOptions } from 'electron';

import { WINDOW_CHROME, WINDOW_PLATFORM } from './constants';

export type WindowPlatform =
  (typeof WINDOW_PLATFORM)[keyof typeof WINDOW_PLATFORM];
export function windowPlatform(input: unknown): WindowPlatform {
  return (
    Object.values(WINDOW_PLATFORM).find((value) => value === input) ??
    WINDOW_PLATFORM.WEB
  );
}
export function windowChrome(
  platform: unknown,
  startup = false,
): BrowserWindowConstructorOptions {
  if (startup) return {};
  if (platform === WINDOW_PLATFORM.MAC)
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: {
        x: WINDOW_CHROME.TRAFFIC_LIGHT_X,
        y: WINDOW_CHROME.TRAFFIC_LIGHT_Y,
      },
    };
  if (
    platform === WINDOW_PLATFORM.WINDOWS ||
    platform === WINDOW_PLATFORM.LINUX
  )
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        height: WINDOW_CHROME.HEIGHT,
        color: WINDOW_CHROME.OVERLAY_COLOR,
        symbolColor: WINDOW_CHROME.OVERLAY_SYMBOL,
      },
    };
  return {};
}

declare global {
  interface Window {
    desktopWindow?: { readonly platform: WindowPlatform };
  }
}
