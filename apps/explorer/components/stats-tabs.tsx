'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-aria-components';

import {
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '../boardui/components/base/tabs/tabs';

export function StatsTabs({
  selected,
  usageHref,
  paymentsHref,
  children,
}: {
  selected: 'usage' | 'payments';
  usageHref: string;
  paymentsHref: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <RouterProvider navigate={(href) => router.push(href, { scroll: false })}>
      <Tabs selectedKey={selected} keyboardActivation="manual">
        <TabList aria-label="Statistics">
          <Tab id="usage" href={usageHref} className="min-h-11">
            Usage
          </Tab>
          <Tab id="payments" href={paymentsHref} className="min-h-11">
            Payments
          </Tab>
        </TabList>
        <TabPanel id={selected}>{children}</TabPanel>
      </Tabs>
    </RouterProvider>
  );
}
