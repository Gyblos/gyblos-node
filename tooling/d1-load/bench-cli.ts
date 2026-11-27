import { measureD1Load } from '../../tests/support/d1-load';
import { formatTable } from './analytics';
import { D1_BENCH_COLUMNS } from './constants';

const rows = await measureD1Load();
if (!rows) {
  process.stderr.write('d1:bench needs node:sqlite\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    formatTable(
      D1_BENCH_COLUMNS,
      rows.map((row) => [
        row.label,
        String(row.statements),
        String(row.roundTrips),
        String(row.batches),
        String(row.maxParams),
        String(row.scans),
      ]),
    ) + '\n',
  );
