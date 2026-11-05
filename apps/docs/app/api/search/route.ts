import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '../../../lib/source';

export const revalidate = false;

// Built once at export time; the browser downloads each locale's index and searches it locally.
export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    en: { language: 'english' },
    es: { language: 'spanish' },
  },
});
