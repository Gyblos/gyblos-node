"""Extract only the timing probe, scenario durations and Node test counts."""
import json
from pathlib import Path
import re
import sys

path, = sys.argv[1:]
text = Path(path).read_text()
cases = re.findall(r'✔ API-key preflight preserves delegated budget: ([\w-]+) \(([\d.]+)ms\)', text)
assert len(dict(cases)) == len(cases) == 30, len(cases)
print('TIMES ' + json.dumps(dict(cases)))
for label in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']:
    value = re.search(r'(?m)^ℹ '+label+r' ([\d.]+)', text)
    assert value, label
    print('COUNT', label, value[1])
worker = re.findall(r'PREFLIGHT_WORKER_MS ([0-9.]+)', text)
assert len(worker) == 1
print('WORKER_MS', worker[0])
assert cases[0][0] == 'model'
