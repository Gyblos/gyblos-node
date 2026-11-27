import { runAnalytics } from './analytics-run';
import { runWrangler } from './wrangler';

process.exitCode = await runAnalytics({
  env: process.env,
  now: Date.now(),
  wrangler: (args) => runWrangler(args),
  fetch: (url, init) => fetch(url, init),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
