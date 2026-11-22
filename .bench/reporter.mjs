import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { availableParallelism } from 'node:os';
export default async function* (source) {
 const records=[],files=[];
 for await(const {type,data:d} of source){
  if(type==='test:pass'||type==='test:fail') {
   const status=d.skip?'skip':d.todo?'todo':type==='test:pass'?'pass':d.details?.error?.failureType??'fail';
   records.push(JSON.stringify([d.file&&relative(process.cwd(),d.file),d.line,d.column,d.name,status]));
   if(type==='test:fail') yield 'TEST_FAILED '+d.name+' '+status+'\n';
  }
  if(type==='test:summary'&&d.file) files.push(relative(process.cwd(),d.file));
  if(type==='test:summary'&&!d.file) yield 'COUNTS '+JSON.stringify(d.counts)+'\n';
 }
 const timings=readdirSync(process.env.PROFILE_DIR).map(f=>JSON.parse(readFileSync(process.env.PROFILE_DIR+'/'+f)));
 if (!timings.length || files.length!==timings.length) throw Error('Missing process profiles: '+timings.length+'/'+files.length);
 yield 'CPU '+availableParallelism()+'\n';
 for(const t of timings)yield 'TIMING '+JSON.stringify(t)+'\n';
 for(const f of files)yield 'FILE '+JSON.stringify(f)+'\n';
 for(const r of records)yield 'CASE '+createHash('sha256').update(r).digest('hex')+'\n';
}
