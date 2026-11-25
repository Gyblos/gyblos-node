import { readFile } from 'node:fs/promises';

export async function previewStyles() {
  const paths = [
    'apps/desktop/src/ui/buyer-controls.css',
    'apps/desktop/src/ui/desktop-design.css',
    'apps/desktop/src/ui/buyer-dialogs.css',
    'lab/tools/desktop-preview/preview.css',
  ];
  return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join(
    '\n',
  );
}
