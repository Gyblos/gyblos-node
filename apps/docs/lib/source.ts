// Loads the MDX pages and sidebars in content/docs, one page tree per language.
import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineDocs } from 'fumadocs-mdx/macro';

import { sidebarIcon } from '../components/sidebar-icons';
import { i18n } from './i18n';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: { output: 'function', headingIds: false },
    },
  },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: '/',
  i18n,
  source: docs.toFumadocsSource(),
  icon: sidebarIcon,
});
