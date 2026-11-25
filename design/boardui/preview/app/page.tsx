'use client';

import { OrdersChartCard } from '@boardui/components/application/dashboard/orders-chart-card';
import { StatCards } from '@boardui/components/application/dashboard/stat-cards';
import { Chip } from '@boardui/components/base/badges/chip';
import { Pagination } from '@boardui/components/base/pagination/pagination';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@boardui/components/base/segmented-control/segmented-control';
import { Select, SelectItem } from '@boardui/components/base/select/select';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@boardui/components/base/table/table';
import {
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@boardui/components/base/tabs/tabs';
import { useState } from 'react';

const periods = ['24h', '7d', '30d', 'All'];
const inventory = [
  ['Segmented control', 'Network and Stats', 'Shared period'],
  ['Select', 'Daily chart', 'Local period override'],
  ['Tabs', 'Stats', 'Usage and Payments'],
  ['Stat cards', 'Network and Stats', 'Period totals'],
  ['Chip', 'Cards and charts', 'Comparable change'],
  ['Orders chart card', 'Charts', 'Layout reference'],
  ['Table', 'Listings', 'Headers and entity links'],
  ['Pagination', 'Every table', 'Rows and navigation'],
];
const pageSize = 4;

export default function Page() {
  const [page, setPage] = useState(1);
  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-4 sm:p-8">
      <header>
        <h1 className="text-title-1-medium">Explorer components</h1>
        <p className="text-body-regular text-text-secondary">
          BoardUI controls proposed for Network and Stats. Chart and card
          figures are sample data.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="grid content-start justify-items-start gap-3 rounded-2xl bg-background-primary-default p-4">
          <h2 className="text-headline-medium">Period selector</h2>
          <SegmentedControl aria-label="Period" defaultSelectedKeys={['All']}>
            {periods.map((period) => (
              <SegmentedControlItem key={period} id={period}>
                {period}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </section>
        <section className="grid gap-3 rounded-2xl bg-background-primary-default p-4">
          <h2 className="text-headline-medium">Chart range</h2>
          <Select aria-label="Chart range" defaultSelectedKey="Overview">
            {['Overview', ...periods].map((period) => (
              <SelectItem key={period} id={period}>
                {period}
              </SelectItem>
            ))}
          </Select>
        </section>
      </div>
      <Tabs defaultSelectedKey="Usage">
        <TabList aria-label="Stats sections">
          <Tab id="Usage">Usage</Tab>
          <Tab id="Payments">Payments</Tab>
        </TabList>
        <TabPanel id="Usage">
          Requests, tokens, latency and unserved demand
        </TabPanel>
        <TabPanel id="Payments">
          Deposits, settlements, seller payouts, fees and refunds
        </TabPanel>
      </Tabs>
      <section className="grid gap-3">
        <h2 className="text-headline-medium">Comparison chips</h2>
        <div className="flex flex-wrap gap-2">
          <Chip color="lime">+9.4%</Chip>
          <Chip color="rose">−3.2%</Chip>
          <Chip color="neutral">No baseline</Chip>
        </div>
      </section>
      <StatCards count={2} columns={2} />
      <OrdersChartCard />
      <section className="grid min-w-0 gap-3">
        <h2 className="text-headline-medium">Component inventory</h2>
        <div className="overflow-x-auto">
          <Table aria-label="Component inventory">
            <TableHeader>
              <TableColumn isRowHeader>Component</TableColumn>
              <TableColumn>Location</TableColumn>
              <TableColumn>Purpose</TableColumn>
            </TableHeader>
            <TableBody>
              {inventory
                .slice((page - 1) * pageSize, page * pageSize)
                .map(([name, location, purpose]) => (
                  <TableRow key={name} id={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell>{location}</TableCell>
                    <TableCell>{purpose}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
        <Pagination
          page={page}
          totalPages={Math.ceil(inventory.length / pageSize)}
          onChange={setPage}
        />
      </section>
    </main>
  );
}
