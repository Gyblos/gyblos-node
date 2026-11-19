import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const dir = 'lab/harness/src/acceptance/';
const probe = path.resolve('.github/phase-bench/clock.cjs');
function edit(file, fn) {
  const before = fs.readFileSync(file,'utf8');
  const after = fn(before);
  if (after === before) throw Error('missing instrumentation: ' + file);
  fs.writeFileSync(file, (before.includes('import __clock')?'':`import __clock from ${JSON.stringify(probe)};\n`) + after);
}
function replace(file, before, after) {
  edit(file,s=>{if(s.split(before).length!==2)throw Error(file+' ambiguous: '+before); return s.replace(before,()=>after);});
}
function wrap(file, name, label, owner) {
  edit(file, s=>{
    const src = ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true);
    const hits=[];
    function walk(n) {
      if ((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isArrowFunction(n)) && n.body && ts.isBlock(n.body)) {
        const key = n.name?.getText(src) ?? (ts.isVariableDeclaration(n.parent)?n.parent.name.getText(src):undefined);
        let par=n.parent;
        while(par && !(ts.isFunctionDeclaration(par)&&par.name?.text===owner))par=par.parent;
        if (key===name && (!owner || par))hits.push(n.body);
      }
      ts.forEachChild(n,walk);
    }
    walk(src); if(hits.length!==1)throw Error(file+' '+name+' '+hits.length);
    const b=hits[0],start=b.getStart(src)+1,end=b.end-1;
    return s.slice(0,start)+`return __clock.span('${label}', async () => {`+s.slice(start,end)+'});'+s.slice(end);
  });
}
for (const [file, title, name] of [
  ['tests/lab/free-acceptance.test.ts','native free acceptance proves','free'],
  ['tests/lab/tools-acceptance.test.ts','native free tool acceptance','tools']]) {
  edit(file,s=>{
    const src=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true);
    const test=src.statements.find(n=>n.getText(src).startsWith('void test(')&&n.getText(src).split(',')[0].includes(title));
    const b=test.expression.expression.arguments.at(-1).body;
    return s.slice(0,b.getStart(src)+1)+`return __clock.target('${name}', async()=>{`+s.slice(b.getStart(src)+1,b.end-1)+'});'+s.slice(b.end-1);
  });
}
wrap(dir+'free-session.ts','createFreeSeller','seller');
wrap(dir+'session.ts','restart','seller','createAcceptanceSession');
wrap(dir+'session.ts','close','close','createAcceptanceSession');
wrap(dir+'host.ts','close','close','startAcceptanceHost');
wrap(dir+'free-buyer.ts','close','close','createFreeBuyer');
wrap(dir+'receipt-startup.ts','start','seller','startReceiptScenario');
wrap(dir+'receipt-startup.ts','closeReceiptHosts','close');
replace(dir+'free-buyer.ts','await delay(ACCEPTANCE.controlRefillMs, undefined, {\n              signal: deadline,\n            });',"await __clock.span('quota', () => delay(ACCEPTANCE.controlRefillMs, undefined, {signal:deadline}));");
replace(dir+'native.ts','return await builder.bind();',"return __clock.endpoint(await __clock.span('bind', () => builder.bind()));");
replace(dir+'receipt-native.ts','const endpoint = await builder.bind();',"const endpoint = __clock.endpoint(await __clock.span('bind', () => builder.bind()));");
wrap('packages/transport-iroh/src/control-client.ts','exchange','exchange','createControlTransport');
wrap('packages/transport-iroh/src/free-client.ts','execute','exchange','createFreeExecutionClient');
wrap(dir+'free-quotes.ts','rawFreeQuote','exchange');
replace(dir+'tools-run.ts','...workspace.environment,',`...workspace.environment,
        ...(process.env.GYB_PHASE_CASE ? {GYB_PHASE_CASE:process.env.GYB_PHASE_CASE,GYB_PHASE_DIR:process.env.GYB_PHASE_DIR,GYB_PHASE_FORK:String(__clock.now())} : {}),`);
replace(dir+'tools-worker.ts','  const controller = new AbortController();',"  if(process.env.GYB_PHASE_FORK) __clock.record('worker-load',Number(process.env.GYB_PHASE_FORK),__clock.now());\n  const controller = new AbortController();");
