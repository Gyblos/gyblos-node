"""Measure the real tests, include preparation, and emit only timings and counts."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

variant, scope = sys.argv[1:]
env = dict(os.environ, CRASH_VARIANT=variant, CRASH_PROFILE='1' if scope == 'focused' else '0')
with tempfile.TemporaryDirectory() as directory:
    env['RUNNER_TEMP'] = directory
    start = time.perf_counter()
    if variant == 'bundle':
        subprocess.run(['node','--experimental-import-meta-resolve','.github/bench-child-build.mjs'], check=True)
    build = time.perf_counter() - start
    if scope == 'focused':
        report = Path(directory) / 'focused.xml'
        command = ['bun','test','--timeout=600000','--reporter=junit','--reporter-outfile',str(report),'./tests/lab/batch-recovery-crash.test.ts']
    else:
        files = sorted(str(p) for p in Path('tests/lab').rglob('*.test.ts'))[::2]
        (Path(directory)/'shard.json').write_text(json.dumps(files))
        env['WORKERS'] = subprocess.check_output(['node','-p',"Math.max(1,require('node:os').availableParallelism()-1)"],text=True).strip()
        command = ['python3','.github/bench-lab-bun.py']
    run = subprocess.run(command,env=env,capture_output=True,text=True)
    total = time.perf_counter() - start
    cases = [case for f in Path(directory).glob('*.xml') for case in ET.parse(f).iter('testcase')]
    counts = {tag: sum(c.find(tag) is not None for c in cases) for tag in ('error','failure','skipped')}
    result = dict(variant=variant, scope=scope, build=round(build,3), total=round(total,3), cases=len(cases), **counts)
    if scope == 'focused':
        obs = [json.loads(m) for m in re.findall(r'CHILD_PHASE (\{[^\n]+\})',run.stdout+'\n'+run.stderr)]
        result['children'] = len(obs)
        result['runtime'] = sorted({(o['runtime'],o['executable'],o['version']) for o in obs})
        marks = ['startMs','processOriginMs','readyMs','firstIpcMs']
        result['phases_s'] = [round(sum(o[b]-o[a] for o in obs)/1000,3) for a,b in zip(marks,marks[1:])]
    print('MEASURE '+json.dumps(result),flush=True)
    assert run.returncode == 0 and counts['error'] == counts['failure'] == 0
    if scope == 'focused':
        assert len(cases) == 10 and len(obs) == 44 and counts['skipped'] == 0
    else:
        assert len(cases) == 176 and counts['skipped'] == 5
