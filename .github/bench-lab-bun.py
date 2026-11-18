"""Run the PR shard with Node's per-file process isolation and parallelism."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

root = Path(os.environ['RUNNER_TEMP'])
files = json.loads((root / 'shard.json').read_text())
assert len(files) == len(set(files)) == 39

def run(file):
    xml = root / (Path(file).name + '.xml')
    try:
        proc = subprocess.run(['bun', 'test', '--timeout=600000', '--reporter=junit',
                               '--reporter-outfile', str(xml), './'+file],
                              capture_output=True, text=True, errors='replace', timeout=360)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        code = 124
    cases = []
    if xml.exists():
        for case in ET.parse(xml).iter('testcase'):
            status = next((tag for tag in ('failure','error','skipped') if case.find(tag) is not None),'pass')
            cases.append([case.get('name'),status])
    print('FILE_RESULT '+json.dumps(dict(file=file,code=code,cases=cases)),flush=True)
    if code and code != 124:
        import re
        # Diagnostic categories only; no captured application data or stack traces.
        errors = re.findall(r'(?m)^\s*(?:error|(?:Type|Assertion|Reference|Syntax)Error)(?: \[[A-Z_]+\])?: ([^\n]+)',proc.stderr)
        print('ERROR_TYPES '+json.dumps([x[:130] for x in dict.fromkeys(errors) if not any(c in x for c in '@/\\{}')][:4]),flush=True)
    return code

with ThreadPoolExecutor(int(os.environ['WORKERS'])) as pool:
    codes = list(pool.map(run,files))
raise SystemExit(int(any(codes)))
