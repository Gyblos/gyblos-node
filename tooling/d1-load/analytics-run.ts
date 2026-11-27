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

export interface AnalyticsDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: number;
  wrangler(args: readonly string[]): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  out(text: string): void;
  err(text: string): void;
}

function wranglerJson(deps: AnalyticsDeps, args: readonly string[]) {
  try {
    return deps.wrangler(args);
  } catch {
    throw new Error(D1_ANALYTICS_ERRORS.WRANGLER_FAILED);
  }
}

async function query(
  deps: AnalyticsDeps,
  token: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(D1_ANALYTICS.graphqlUrl, {
      method: 'POST',
      redirect: 'error',
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

async function report(deps: AnalyticsDeps) {
  const token =
    deps.env[D1_ANALYTICS.tokenEnv] ||
    parseToken(wranglerJson(deps, ['auth', 'token', '--json']));
  const account =
    deps.env[D1_ANALYTICS.accountEnv] ||
    parseAccountId(wranglerJson(deps, ['whoami', '--json']));
  const databases = D1_ANALYTICS.databases.map((name) => ({
    name,
    ...parseDatabaseInfo(wranglerJson(deps, ['d1', 'info', name, '--json'])),
  }));
  const window = analyticsWindow(deps.now);
  const totals = parseAnalytics(
    await query(
      deps,
      token,
      analyticsRequest(
        account,
        databases.map((database) => database.id),
        window,
      ),
    ),
  );
  return (
    `D1 analytics ${window.start}..${window.end} (UTC, ${D1_ANALYTICS.windowDays} complete days)\n` +
    formatTable(D1_ANALYTICS_COLUMNS, analyticsRows(databases, totals)) +
    '\n'
  );
}

const codes: readonly string[] = Object.values(D1_ANALYTICS_ERRORS);

export async function runAnalytics(deps: AnalyticsDeps): Promise<0 | 1> {
  try {
    deps.out(await report(deps));
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && codes.includes(error.message)
        ? error.message
        : D1_ANALYTICS_ERRORS.UNEXPECTED;
    deps.err(`d1:analytics failed: ${code}\n`);
    return 1;
  }
}
