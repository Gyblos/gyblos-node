// The site languages. English is the default; Spanish pages are *.es.mdx next to them.
import { defineI18n } from 'fumadocs-core/i18n';

// Static export has no middleware, so every page keeps its locale prefix: /en/… and /es/….
export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'es'],
  hideLocale: 'never',
});
