import { run } from './entry';

const code = await run(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
