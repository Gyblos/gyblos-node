// One buyer entry: verify a signed quote first, then execute free or prepare its paid channel.
import { isMain } from '@gyblos/runtime';

import { startBuyer } from './buyer-startup';
import { main } from './free-main';

export { startBuyer } from './buyer-startup';

if (isMain(import.meta.url)) await main(startBuyer);
