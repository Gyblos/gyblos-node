// The seller's executable entry point; entry.ts routes the command.
import { run } from './entry';

await run(process.argv.slice(2));
