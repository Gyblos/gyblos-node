import type { ReactNode } from 'react';

import './gallery.css';

export const metadata = { title: 'Explorer components · BoardUI' };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background-full text-text-primary">{children}</body>
    </html>
  );
}
