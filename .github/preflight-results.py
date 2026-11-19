"""Extract only the timing probe, scenario durations and Node test counts."""
import json
from pathlib import Path
import re
import sys

path, mode = sys.argv[1:]
text = Path(path).read_text()
cases = re.findall(r'✔ API-key preflight preserves delegated budget: ([\w-]+) \(([\d.]+)ms\)', text)
assert len(dict(cases)) == len(cases) == 30, len(cases)
print('TIMES ' + json.dumps(dict(cases)))
for label in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']:
    value = re.search(r'(?m)^ℹ '+label+r' ([\d.]+)', text)
    assert value, label
    print('COUNT', label, value[1])
if mode == 'profile':
    def records(prefix):
        result = [json.loads(line) for line in re.findall(prefix + r' (\{[^\n]+\})', text)]
        assert len(result) == 30
        return {row['scenario']: row for row in result}
    starts, ends = records('PREFLIGHT_CASE'), records('PREFLIGHT_END')
    marks = ['began', 'directoryReady', 'spawning', 'entry', 'staticReady', 'hooksReady',
             'dynamicReady', 'ready', 'validated', 'closed', 'returned', 'end']
    for case, _ in cases:
        data = {**starts[case], **ends[case]}
        intervals = {b: round(data[b]-data[a], 3) for a,b in zip(marks,marks[1:])}
        assert min(intervals.values()) >= 0
        print('PHASE', case, json.dumps(intervals))
