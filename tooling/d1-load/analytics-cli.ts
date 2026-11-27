import { execFileSync } from 'node:child_process';

import { wranglerLaunch } from '@gyblos/discovery-index/wrangler-d1';

import {
  analyticsRequest,
  analyticsRows,
  analyticsWindow,
  formatTable,
  parseAccountId,
  parseAnalytics,
  parseDatabaseInfo,
  parseToken,
} from './analytics';
import {
  D1_ANALYTICS,
  D1_ANALYTICS_COLUMNS,
  D1_ANALYTICS_ERRORS,
} from './constants';

function wrangler(args: readonly string[]): string {
  try {
    const launch = wranglerLaunch(process.platform, process.execPath, args);
    return execFileSync(launch.file, launch.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    throw new Error(D1_ANALYTICS_ERRORS.WRANGLER_FAILED);
  }
}

async function query(token: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(D1_ANALYTICS.graphqlUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(D1_ANALYTICS_ERRORS.REQUEST_FAILED);
  }
  if (!response.ok) throw new Error(D1_ANALYTICS_ERRORS.REQUEST_FAILED);
  try {
    return await response.json();
  } catch {
    throw new Error(D1_ANALYTICS_ERRORS.BAD_RESPONSE);
  }
}

async function main() {
  const token =
    process.env[D1_ANALYTICS.tokenEnv] ||
    parseToken(wrangler(['auth', 'token', '--json']));
  const account =
    process.env[D1_ANALYTICS.accountEnv] ||
    parseAccountId(wrangler(['whoami', '--json']));
  const databases = D1_ANALYTICS.databases.map((name) => ({
    name,
    ...parseDatabaseInfo(wrangler(['d1', 'info', name, '--json'])),
  }));
  const window = analyticsWindow(Date.now());
  const totals = parseAnalytics(
    await query(
      token,
      analyticsRequest(
        account,
        databases.map((database) => database.id),
        window,
      ),
    ),
  );
  process.stdout.write(
    `D1 analytics ${window.start}..${window.end} (UTC, ${D1_ANALYTICS.windowDays} complete days)\n` +
      formatTable(D1_ANALYTICS_COLUMNS, analyticsRows(databases, totals)) +
      '\n',
  );
}

const codes: readonly string[] = Object.values(D1_ANALYTICS_ERRORS);
void main().catch((error: unknown) => {
  const code =
    error instanceof Error && codes.includes(error.message)
      ? error.message
      : D1_ANALYTICS_ERRORS.UNEXPECTED;
  process.stderr.write(`d1:analytics failed: ${code}\n`);
  process.exitCode = 1;
});
