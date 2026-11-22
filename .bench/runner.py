import os,sys,json,subprocess
from pathlib import Path
mode,suite,shard=sys.argv[1:];tmp=Path(os.environ['RUNNER_TEMP']);out=tmp/'profile-files';out.mkdir()
os.environ['PROFILE_DIR']=str(out)
patterns=['tests/*.test.ts','packages/*/test/**/*.test.ts'] if suite=='test' else ['tests/lab/**/*.test.ts']
args=['node','--import',str(tmp/'mark.cjs'),'--import','tsx','--test','--test-reporter='+str(tmp/'reporter.mjs')]
if mode!='candidate':args+=['--test-shard='+shard+'/'+('3' if suite=='test' else '2')]+patterns
else:args+=json.loads((tmp/'plan.json').read_text())[suite][int(shard)-1]
os.environ['PROFILE_PARENT']=str(os.getpid())
os.execvp(args[0],args)
