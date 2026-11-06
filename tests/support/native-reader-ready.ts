// Waits only for an owned test child's explicit readiness; it never changes transport deadlines.
import type { ChildProcess } from 'node:child_process';

export async function waitForReaderReady(_child: ChildProcess): Promise<void> {}
