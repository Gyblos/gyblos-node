import { CaretRight, Check } from '@phosphor-icons/react';

import { usdPerMtok } from './model-price';
import type { ModelOption } from './model-types';
import { TONE } from './status-tone';
import { Tag } from './Tag';

export function ModelMenuBadges({
  offers,
}: {
  offers: readonly ModelOption[];
}) {
  const free = offers.some((offer) => offer.free);
  const paid = offers.some((offer) => !offer.free);
  return (
    <>
      <Tag pill tone={free ? TONE.SUCCESS : TONE.NEUTRAL}>
        {free && paid ? 'Free and paid' : free ? 'Free' : 'Paid'}
      </Tag>
      <span className="pk-badge-line">
        {!free && paid && (
          <Tag>
            {offers.length > 1 ? 'from ' : ''}
            {usdPerMtok(Math.min(...offers.map((offer) => offer.input)))}/M
          </Tag>
        )}
        <Tag>
          {offers.length} {offers.length === 1 ? 'offer' : 'offers'}
        </Tag>
      </span>
    </>
  );
}
export function ModelMenuTrail({
  selected,
  multiple,
}: {
  selected: boolean;
  multiple: boolean;
}) {
  return (
    <span className="preview-menu-trail">
      {selected ? (
        <span className="preview-check-circle">
          <Check size={11} weight="bold" />
        </span>
      ) : (
        <span className="preview-check-slot" />
      )}
      {multiple ? (
        <CaretRight size={13} className="preview-menu-caret" />
      ) : (
        <span className="preview-caret-slot" />
      )}
    </span>
  );
}
