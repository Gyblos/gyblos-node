import { ArrowUpRight, type Icon } from '@phosphor-icons/react';
import { useState } from 'react';

import { HISTORY } from './history-constants';
import { priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { Pagination } from './Pagination';
import { TONE } from './status-tone';
import { Tag } from './Tag';
import { IconButton } from './UI';

export function OfferTable({
  name,
  offers,
  selected,
  choose,
  icon: Action = ArrowUpRight,
}: {
  name: string;
  offers: readonly ModelOption[];
  selected?: string;
  choose(id: string): void;
  icon?: Icon;
}) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const current = Math.min(page, Math.max(1, Math.ceil(offers.length / size)));
  return (
    <>
      <div className="preview-simple-table-region">
        <table className="preview-simple-table">
          <caption className="sr-only">Offers for {name}</caption>
          <OfferHead />
          <tbody>
            {offers.slice((current - 1) * size, current * size).map((offer) => (
              <tr key={offer.id} data-active={offer.id === selected}>
                <th scope="row">
                  <span className="preview-seller-name">
                    {offer.family || name}
                    {offer.id === selected && (
                      <Tag tone={TONE.INFO} dot>
                        Selected
                      </Tag>
                    )}
                  </span>
                </th>
                <td className="preview-num preview-tabular">
                  {offer.free ? 'Free' : priceRange(offer)}
                </td>
                <td className="preview-num" aria-label="Latency unavailable">
                  —
                </td>
                <td className="preview-num preview-limit-action">
                  <IconButton
                    label={'Choose offer ' + (offer.family || name)}
                    onClick={() => choose(offer.id)}
                  >
                    <Action size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
            {!offers.length && (
              <tr>
                <td colSpan={4}>No matching offers.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {offers.length >= HISTORY.PAGE_SIZES[0] && (
        <Pagination
          label="Seller pagination"
          page={current}
          total={offers.length}
          pageSize={size}
          onPage={setPage}
          onPageSize={(n) => {
            setSize(n);
            setPage(1);
          }}
        />
      )}
    </>
  );
}

function OfferHead() {
  return (
    <thead>
      <tr>
        <th scope="col">Seller / variant</th>
        <th scope="col" className="preview-num">
          In / out · 1M
        </th>
        <th scope="col" className="preview-num">
          Latency
        </th>
        <th scope="col">
          <span className="sr-only">Choose offer</span>
        </th>
      </tr>
    </thead>
  );
}
