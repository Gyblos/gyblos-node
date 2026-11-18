// Child-only source that installs the same synthetic loader substitutions on Bun.
export function bunFixtureLoader(
  modules: readonly { name: string; module: string; actual?: string }[],
  parent?: string,
) {
  const loader = new URL('./bun-child-loader.mjs', import.meta.url).href;
  return `import {installFixtures} from ${JSON.stringify(loader)};
    installFixtures(${JSON.stringify(modules)}, ${JSON.stringify(parent)});`;
}
