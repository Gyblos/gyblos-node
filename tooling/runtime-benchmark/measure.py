"""Measure a staged seller on a fresh hosted runner. Print aggregate-safe evidence only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

runtime = sys.argv[1]
windows = os.name == 'nt'
repo = Path.cwd()
bench = repo / 'tooling/runtime-benchmark'
target = 'win32-x64' if windows else 'linux-x64'
node = Path(shutil.which('node')).resolve()
binary = Path(shutil.which(runtime)).resolve()
flags = ['run','--no-config','--no-lock','--cached-only','--node-modules-dir=manual','-A'] if runtime == 'deno' else []
tar = str(Path(os.environ['SystemRoot'])/'System32/tar.exe') if windows else 'tar'
version = '0.0.0-bench.1'
with tempfile.TemporaryDirectory() as scratch:
    root = Path(scratch)
    subprocess.run([node,'--import','tsx','tooling/native-build-cli.ts','--version',version,'--target',target,'--node',node,'--out',root],check=True)
    name = f'gyblos-{version}-{target}'
    archive = root/(name+'.tar.gz')
    subprocess.run([tar,'-xzf',archive.name],cwd=root,check=True)
    stage = root/name
    ext = '.exe' if windows else ''
    launcher = stage/('bin/gyblos.cmd' if windows else 'bin/gyblos')
    if runtime != 'node':
        (stage/'runtime'/('node'+ext)).unlink()
        shutil.copy2(binary,stage/'runtime'/(runtime+ext))
        old = 'runtime\\node.exe"' if windows else 'runtime/node"'
        new = old.replace('node',runtime)+' '+' '.join(flags)
        source = launcher.read_text()
        assert old in source
        launcher.write_text(source.replace(old,new))
    installed = sum(f.stat().st_size for f in stage.rglob('*') if f.is_file())
    subprocess.run([tar,'-czf','variant.tar.gz',name],cwd=root,check=True)
    cli = subprocess.check_output([str(launcher),'--version'],text=True,cwd=root).strip()
    assert cli == version, cli
    lib = stage/'lib'
    subprocess.run([node,bench/'bundle.cjs',lib],check=True)
    sizes = dict(installed=installed,archive=(root/'variant.tar.gz').stat().st_size)
    cmd = [str(stage/'runtime'/(runtime+ext)),*flags]
    for iteration in range(8):
        for case in ['fresh','reused','request']:
            with tempfile.TemporaryDirectory(dir=root) as tmp:
                env = dict(os.environ, HOME=tmp, USERPROFILE=tmp, TMPDIR=tmp,TMP=tmp,TEMP=tmp,
                           DENO_DIR=str(root/'cache') if case=='reused' else tmp+'/cache',
                           DENO_NO_UPDATE_CHECK='1', GYBLOS_HOME=tmp+'/home',GYBLOS_LAB_HOME=tmp+'/lab',
                           GYBLOS_CONFIG=str(Path(tmp)/'paid-acceptance.toml'),GYBLOS_RELAY_ONLY='0',
                           GYBLOS_RPC_URL='http://127.0.0.1:9')
                if case != 'request':
                    subprocess.run([node,lib/'prep-entry.mjs'],cwd=tmp,env=env,check=True,timeout=45)
                entry = 'request' if case=='request' else 'seller'
                start = time.perf_counter()
                props = {}
                with subprocess.Popen([*cmd,lib/(entry+'-entry.mjs')],cwd=tmp,env=env,text=True,stdout=subprocess.PIPE) as proc:
                    for line in proc.stdout:
                        mark = line.strip()
                        if mark == 'BENCH_READY' or mark == 'BENCH_OK':
                            props['ms']=round((time.perf_counter()-start)*1000,2)
                        if mark.startswith('BENCH_RSS '):
                            props['rss']=int(mark.split()[1])
                    assert proc.wait()==0, (runtime,case,'exit')
                assert 'ms' in props and (case=='request' or props.get('rss',0)>0), (case,'missing evidence')
                print('SELLER_RESULT '+json.dumps(dict(runtime=runtime,case=case,iteration=iteration,**props,**sizes)),flush=True)
