import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { ModelsSection } from '../../components/models-section';
import { PageFrame } from '../../components/page-frame';
import { Loading } from '../../components/ui';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, readQuery } from '../../lib/paging';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata(
  'Models',
  PAGES.models,
  'Every model on the Gyblos network: how many sellers offer it now, the lowest paid prices, context and what was served free and paid.',
);

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const canonical = canonicalPageHref(params, PAGES.models);
  if (canonical) redirect(canonical);
  const query = readQuery(params, PAGES.models);
  return (
    <PageFrame title="Gyblos models">
      <Suspense fallback={<Loading />}>
        <ModelsSection query={query} />
      </Suspense>
    </PageFrame>
  );
}
