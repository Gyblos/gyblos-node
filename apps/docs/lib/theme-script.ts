// The theme library renders an inline script that sets the theme class before the first paint. That script runs
// only from the static HTML; a later client render (switching language re-renders the root layout) creates it
// again, and React 19 warns about any executable script it renders on the client. On the client the script is
// therefore rendered as a data block, which React accepts and which never ran there anyway.
import { SCRIPT_DATA_TYPE } from './constants';

export function themeScriptProps(
  onClient: boolean,
): { type: string } | undefined {
  return onClient ? { type: SCRIPT_DATA_TYPE } : undefined;
}
