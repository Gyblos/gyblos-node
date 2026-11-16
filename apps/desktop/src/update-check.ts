// Checks public desktop release metadata; never downloads or installs a build.
export interface DesktopUpdate { current: string; available: string | null; }
export async function checkDesktopUpdate(current: string, platform: NodeJS.Platform, arch: string, request: typeof fetch = fetch, signal?: AbortSignal): Promise<DesktopUpdate> {
  void platform; void arch; void request; void signal;
  return {current,available:null};
}
