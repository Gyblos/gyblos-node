import { SELLERS_ONLINE } from '../lib/constants';
import { getSellersOnlineHistory } from '../lib/network-history';
import { SellersOnlineChart } from './sellers-online-chart';
import { SectionTitle, Unavailable } from './ui';

const TITLE = 'Sellers online';
const HELP =
  'NodeIds with an accepted presence in each 5-minute slot, averaged over the UTC day. Close to, but not the same as, the sellers online now.';

export async function SellersOnlineHistory() {
  const history = await getSellersOnlineHistory();
  if (history.error)
    return <Unavailable title={TITLE} anchors={[SELLERS_ONLINE.anchor]} />;
  return (
    <section>
      <SectionTitle id={SELLERS_ONLINE.anchor} title={TITLE} help={HELP} />
      <SellersOnlineChart days={history.days} />
    </section>
  );
}
