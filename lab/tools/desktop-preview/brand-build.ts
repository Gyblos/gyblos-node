// Applies the public brand and composer-copy proposals only to browser bundles, with portable IDs.
// Shipped desktop sources and operational configuration are never changed.

import type { InlineConfig, Plugin } from 'vite';

import brand from './brand.json' with { type: 'json' };

export { brand };
const moduleId = (value: string) => value.replaceAll('\\', '/');
function replaceOnce(source: string, before: string, after: string) {
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error(
      'Desktop brand review hook changed; update the preview explicitly.',
    );
  return source.replace(before, after);
}
export function transformBrand(source: string, id: string, desktop: string) {
  source = source.replaceAll('\r\n', '\n');
  const target = moduleId(id);
  const base = moduleId(desktop).replace(/\/$/, '');
  if (target === `${base}/src/ui/Chat.tsx`)
    return replaceOnce(source, "'Free · Gyblos network'", "''");
  if (target === `${base}/src/theme.ts`) {
    for (const [name, value] of Object.entries(brand.themeTokens)) {
      const pattern = new RegExp(`  ${name}: '[^']+',`);
      if (!pattern.test(source)) throw new Error('Missing desktop brand token');
      source = source.replace(pattern, `  ${name}: '${value}',`);
    }
    source = replaceOnce(
      source,
      "'--blue': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 35%)',",
      "'--blue': light ? colors.inkLight : colors.inkDark,",
    );
    return replaceOnce(
      source,
      "'--focus': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 12%)',",
      "'--focus': light ? colors.inkLight : colors.inkDark,",
    );
  }
  if (target === `${base}/src/ui/Signal.tsx`) {
    const start = source.indexOf('export function SignalMark(');
    const end = source.indexOf('export function SignalTrace(');
    if (start < 0 || end <= start)
      throw new Error('Missing desktop mark review hook');
    const mark = `export function SignalMark() { return createElement('span', {className:'preview-brand-mark','aria-hidden':true}, createElement('img',{className:'preview-brand-dark',src:'./gyblos-mark-solid-dark.svg',alt:''}),createElement('img',{className:'preview-brand-light',src:'./gyblos-mark-solid-light.svg',alt:''})); }\n`;
    return (
      "import { createElement } from 'react';\n" +
      source.slice(0, start) +
      mark +
      source.slice(end)
    );
  }
}
export function reviewBrand(desktop: string): Plugin {
  return {
    name: 'desktop-brand-review',
    enforce: 'pre',
    transform(source, id) {
      return transformBrand(source, id, desktop);
    },
  };
}
export function isolatePreviewBuild(config: InlineConfig): InlineConfig {
  return { ...config, configFile: false, envDir: false, envPrefix: [] };
}
