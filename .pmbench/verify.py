import hashlib, os, pathlib, re
from pathlib import Path
s=next(Path('patches').glob('*svm*.patch')).read_text()
pairs=re.findall(r'diff --git a/\S+ b/(\S+)\nindex [0-9a-f]+\.\.([0-9a-f]+)',s)
assert len(pairs)==18
for f,h in pairs:
 b=(Path('node_modules/@x402/svm')/f).read_bytes()
 assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==h,f
print('Verified all 18 installed patch blobs.')
