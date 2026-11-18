// Bundle the same test entries beside the staged seller's native dependencies.
const {readFileSync, writeFileSync} = require('node:fs');
const path = require('node:path');
const {build} = require('esbuild');
async function main() {
  for (const name of ['prep', 'seller', 'request']) {
    await build({
      stdin: {contents: readFileSync(path.join(__dirname, name+'.txt'),'utf8'), resolveDir:process.cwd(),loader:'ts'},
      bundle:true,platform:'node',target:'node24',format:'esm',external:['@number0/iroh'],
      banner:{js:"import { createRequire as makeRequire } from 'node:module'; const require=makeRequire(import.meta.url);"},
      outfile:path.join(process.argv[2],name+'.mjs'),
    });
    // Preserve import-time CLI guards when multiple entries share a bundle.
    writeFileSync(path.join(process.argv[2],name+'-entry.mjs'),"import './"+name+".mjs';\n");
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
