// The seller installer, served byte for byte from the repository's install.sh at build time so the
// published script is always the one on main (gyblos.com/install.sh redirects here).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(await readFile(join(process.cwd(), '../../install.sh')), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
