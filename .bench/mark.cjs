const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[1] && path.relative(process.cwd(), process.argv[1]);
if (process.env.NODE_TEST_CONTEXT === 'child-v8' && process.ppid === Number(process.env.PROFILE_PARENT) && file?.endsWith('.test.ts')) {
  process.on('exit', () => fs.writeFileSync(path.join(process.env.PROFILE_DIR, process.pid+'.json'), JSON.stringify({file,start:performance.timeOrigin,ms:performance.now()})));
} else if (!process.env.PROFILE_PARENT) {
  process.env.PROFILE_PARENT = String(process.pid);
}
