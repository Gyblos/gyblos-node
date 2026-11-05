// The site-wide 404 (out/404.html): outside [lang], so it offers both languages with the Gyblos theme.
import type { Metadata } from 'next';

import './global.css';

export const metadata: Metadata = { title: 'Page not found · Gyblos Docs' };

export default function GlobalNotFound() {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-fd-background p-6 text-center text-fd-foreground">
        <p className="font-mono text-sm text-fd-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold">
          Page not found · Página no encontrada
        </h1>
        <p className="flex gap-4">
          <a className="text-fd-primary underline" href="/en">
            English docs
          </a>
          <a className="text-fd-primary underline" href="/es">
            Documentación en español
          </a>
        </p>
      </body>
    </html>
  );
}
