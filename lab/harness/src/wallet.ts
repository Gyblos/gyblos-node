// Guard identity and validator scratch before creating lab state.
import { labLayout } from '@gyblos/config';
import { assertNoLegacyState } from '@gyblos/node/home';

import { labStatePaths, LEGACY_LAB_PATHS } from './constants';

export function assertLabHome() {
  return assertNoLegacyState(
    labLayout(process.env).root,
    labStatePaths(),
    LEGACY_LAB_PATHS,
  );
}
