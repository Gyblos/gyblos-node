import type { ComponentProps } from 'react';

import { getDiscovery } from '../lib/discovery-render';
import { modelView } from '../lib/model-catalog';
import { ModelCategories } from './model-categories';
import { ModelName } from './ui';

export async function CatalogModelName({
  withCategories = false,
  ...props
}: Omit<ComponentProps<typeof ModelName>, 'models'> & {
  withCategories?: boolean;
}) {
  const { models } = await getDiscovery();
  return (
    <>
      <ModelName {...props} models={models} />
      {withCategories ? (
        <ModelCategories
          categories={modelView(models, props.modelId).categories}
        />
      ) : null}
    </>
  );
}
