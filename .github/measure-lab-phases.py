"""Instrument only the disposable runner checkout. Measurements contain fixed phase labels and times."""
from pathlib import Path
import json,os
dest=json.dumps(os.path.join(os.environ['RUNNER_TEMP'],'lab-phases.jsonl'))
header="import { appendFileSync as saveSpan } from 'node:fs';\nfunction observePhase(phase:string, start:number){saveSpan("+dest+",JSON.stringify({phase,ms:performance.now()-start})+'\\n')}\n"
def patch(name,start,changed):
 p=Path(name);s=p.read_text();assert s.count(start)==1
 p.write_text(header+s.replace(start,changed))
p='tests/support/'
s='await delay(ACCEPTANCE.controlRefillMs, undefined, { signal });'
patch(p+'paid-acceptance-http.ts',s,'const began=performance.now(); '+s+" observePhase('paid.quota',began);")
s='async restart(both: boolean, afterStop?: () => void) {'
t=Path(p+'paid-acceptance-host.ts')
patch(t,s,s+'const began=performance.now();')
s='await startBuyer();\n      },\n    };'
assert t.read_text().count(s)==1
t.write_text(t.read_text().replace(s,"await startBuyer(); observePhase('paid.restart',began);\n      },\n    };"))
s='const child = fork(entry, [], {'
patch(p+'channel-crash-process.ts',s,'const began=performance.now(); '+s)
t=Path(p+'channel-crash-process.ts')
s="  const reached = deferred<void>();"
t.write_text(t.read_text().replace(s,"  child.once('message',()=>observePhase('crash.first-ipc',began));\n"+s))
s='const report = await runIdentityAcceptance();'
patch('tests/lab/identity-acceptance.test.ts',s,"let began=performance.now();const report=await runIdentityAcceptance({onCase(value){observePhase('identity.'+value,began);began=performance.now()}});")
