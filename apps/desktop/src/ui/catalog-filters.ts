import { useState } from 'react';

import type { CatalogModel } from './model-types';

const CONTEXT = { 'Any context': 0, '128K+': 131072, '256K+': 262144 } as const;
const ALL_VARIANTS = 'All variants';
const MODEL_SORT = ['Most offers', 'Lowest price', 'Name'] as const;
export function useCatalogFilters(models: readonly CatalogModel[]) {
  const [variant, setVariant] = useState(ALL_VARIANTS);
  const [context, setContext] = useState<keyof typeof CONTEXT>('Any context');
  const [sort, setSort] = useState<(typeof MODEL_SORT)[number]>(MODEL_SORT[0]);
  const variants = [
    ALL_VARIANTS,
    ...new Set(
      models.flatMap((model) => (model.variant ? [model.variant] : [])),
    ),
  ];
  const filtered = models.filter(
    (model) =>
      (variant === ALL_VARIANTS || model.variant === variant) &&
      (model.contextTokens ?? 0) >= CONTEXT[context],
  );
  const groups = new Map<string, CatalogModel[]>();
  for (const model of filtered) {
    const rows = groups.get(model.name) ?? [];
    rows.push(model);
    groups.set(model.name, rows);
  }
  const ordered = [...groups].sort(([name, left], [other, right]) => {
    if (sort === MODEL_SORT[2]) return name.localeCompare(other);
    if (sort === MODEL_SORT[1])
      return (
        Math.min(...left.map((row) => row.input)) -
        Math.min(...right.map((row) => row.input))
      );
    return (
      right.reduce((sum, row) => sum + row.providers, 0) -
      left.reduce((sum, row) => sum + row.providers, 0)
    );
  });
  return {
    groups,
    ordered,
    variant,
    variants,
    setVariant,
    context,
    contexts: Object.keys(CONTEXT),
    setContext: (value: string) => {
      if (value === 'Any context' || value === '128K+' || value === '256K+')
        setContext(value);
    },
    sort,
    sorts: MODEL_SORT,
    setSort,
  };
}
