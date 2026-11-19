"""Partition each target's elapsed time. All timestamps use the Linux monotonic clock."""
import json
import re
import sys
from pathlib import Path
from collections import Counter

root = Path(sys.argv[1])
spec = (root / 'spec.log').read_text()
labels = {'free':'native free acceptance proves publication to HTTP answer and typed refusal/failover cases',
          'tools':'native free tool acceptance traverses both client formats, terminals and refusal paths'}
rows=[row for f in root.glob('*.json') for row in json.loads(f.read_text())]
order = ['close','seller','quota','worker-load','iroh','other']
def union(pairs):
    merged=[]
    for a,b in sorted(pairs):
        if merged and a<=merged[-1][1]:
            merged[-1][1]=max(merged[-1][1],b)
        else: merged.append([a,b])
    return sum(b-a for a,b in merged)
for case,title in labels.items():
    target=[(a,b) for c,k,a,b in rows if c==case and k=='total']
    assert len(target)==1,(case,target)
    start,end=target[0]
    spec_ms=float(re.search(r'✔ '+re.escape(title)+r' \(([\d.]+)ms\)',spec)[1])
    assert abs(spec_ms-(end-start))<max(100,0.02*spec_ms)
    spans=[(k,max(start,a),min(end,b)) for c,k,a,b in rows if c==case and k!='total' and a<end and b>start]
    kinds=Counter(k for k,a,b in spans)
    assert kinds['seller']>0 and kinds['endpoint-close']>0 and kinds['dial']>0 and kinds['exchange']>0
    if case=='tools':assert kinds['worker-load']==12 and kinds['seller']==12
    if case=='free':assert kinds['quota']>0
    by_kind={k:round(union([(a,b) for key,a,b in spans if key==k])/1000,4) for k in kinds}
    cats={'close-first':'close','close-again':'close','endpoint-close':'close','close':'close','seller':'seller','quota':'quota','worker-load':'worker-load','bind':'iroh','dial':'iroh','exchange':'iroh'}
    points=sorted({start,end,*[v for _,a,b in spans for v in (a,b)]})
    parts=Counter()
    for a,b in zip(points,points[1:]):
        active={cats[k] for k,l,r in spans if l<=a and b<=r}
        cat=next((k for k in order if k in active),'other')
        parts[cat]+=b-a
    assert abs(sum(parts.values())-(end-start))<0.1
    print('PHASE_SUMMARY '+json.dumps(dict(case=case,test_s=round(spec_ms/1000,4),
            counts=kinds,inclusive_s=by_kind,exclusive_s={k:round(parts[k]/1000,4) for k in order})))
for field in ('tests','pass','fail','cancelled','skipped','duration_ms'):
    m=re.search(r'ℹ '+field+r' ([\d.]+)',spec)
    print('LAB_COUNT',field,m[1])
