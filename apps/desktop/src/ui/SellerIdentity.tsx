import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import { TONE } from './status-tone';
import { Tag } from './Tag';

export function SellerIdentity({
  model,
  remaining,
  switching,
  verified,
}: {
  model: CatalogModel;
  remaining?: string;
  switching?: string;
  verified: boolean;
}) {
  return (
    <>
      <div className="preview-detail-head">
        <Tag tone={TONE.INFO} dot>
          Awaiting confirmation
        </Tag>
        {remaining ? (
          <Tag tone={TONE.SUCCESS} dot>
            Active channel
          </Tag>
        ) : (
          <Tag tone={TONE.WARNING} dot>
            {!verified
              ? 'Channel not verified'
              : switching
                ? 'Channel change'
                : 'Deposit required'}
          </Tag>
        )}
      </div>
      <div className="paid-model-summary">
        <ModelImage name={model.name} artwork={model.image} />
        <div>
          <strong>{model.name}</strong>
          <p className="ui-help-text">{model.family}</p>
        </div>
      </div>
    </>
  );
}
