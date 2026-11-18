// Synthetic module replacements for isolated Bun children. Production modules run normally outside the selected imports.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { plugin, resolveSync } from 'bun';

export function installFixtures(rules, parentUrl) {
  plugin({
    name: 'acceptance fixture modules',
    setup(build) {
      function intercept(path, load) {
        build.onLoad(
          { filter: new RegExp('^' + RegExp.escape(path) + '$') },
          load,
        );
      }
      if (parentUrl) {
        const path = fileURLToPath(parentUrl);
        intercept(path, () => {
          let contents = readFileSync(path, 'utf8');
          for (const rule of rules) {
            const specifier = "'" + rule.name + "'";
            if (!contents.includes(specifier))
              throw new Error('Missing fixture import');
            const replacement =
              'data:text/javascript;base64,' +
              Buffer.from(rule.module).toString('base64');
            contents = contents.replaceAll(
              specifier,
              JSON.stringify(replacement),
            );
          }
          return { contents, loader: 'ts' };
        });
        return;
      }
      for (const rule of rules) {
        const path = rule.actual
          ? fileURLToPath(rule.actual)
          : resolveSync(rule.name, process.cwd());
        // A separate module URL lets the wrapper delegate to the real implementation.
        const contents = rule.module.replaceAll(
          "'" + rule.name + "'",
          JSON.stringify(path + '?fixture-original'),
        );
        intercept(path, () => ({ contents, loader: 'js' }));
      }
    },
  });
}
