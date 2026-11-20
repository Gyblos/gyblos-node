'use client';

// Owns the network selector in the header: devnet is the only network with data; mainnet is listed but
// not selectable until it launches.
import { NETWORKS } from '../lib/config';
import { Select } from './board/select';

const OPTIONS = NETWORKS.map((network) => ({
  id: network.id,
  label: network.label,
  ...(network.live ? {} : { hint: 'soon', disabled: true }),
}));

export function NetworkSelect() {
  return <Select label="Network" options={OPTIONS} selected={NETWORKS[0].id} />;
}
