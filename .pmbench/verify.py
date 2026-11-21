import hashlib, os, pathlib, re
from pathlib import Path
s=next(Path('patches').glob('*svm*.patch')).read_text()
pairs=re.findall(r'diff --git a/\S+ b/(\S+)\nindex [0-9a-f]+\.\.([0-9a-f]+)',s)
assert len(pairs)==18
for f,h in pairs:
 b=(Path('node_modules/@x402/svm')/f).read_bytes()
 norm=b.replace(bytes([13,10]),bytes([10]))
 def blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+bytes([0])+data).hexdigest()
 assert blob(norm)==h,(f,h,blob(b),blob(norm),b.count(bytes([13,10])))
print('Verified all 18 installed patch blobs with Git LF normalization.')
