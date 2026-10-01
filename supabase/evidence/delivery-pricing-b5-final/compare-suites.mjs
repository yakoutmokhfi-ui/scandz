// Compare exact normalized file/line/test identities, not merely fail counts.
// node compare-suites.mjs baseline.tap[.gz] candidate.tap[.gz] output-directory
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
const [baseline,candidate,out]=process.argv.slice(2);
if(!out)throw Error('Expected baseline, candidate, output directory');
const normalize=s=>s.replace(/\\+/g,'/').replace(/\/{2,}/g,'/').replace(/\r/g,'');
function parse(file){
 const raw=readFileSync(file);const text=(file.endsWith('.gz')?gunzipSync(raw):raw).toString('utf8').replace(/\r\n/g,'\n');
 const lines=text.split('\n'),ids=new Set();
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(/^\s*not ok \d+ - (.*)$/);if(!m)continue;
  for(let j=i+1;j<Math.min(i+15,lines.length);j++){
   const loc=normalize(lines[j]).match(/^\s*location: '(?:.*\/)?(tests\/[^']*?):(\d+):\d+'$/);
   if(loc){ids.add(`${loc[1]}:${loc[2]} | ${normalize(m[1].trim())}`);break;}
   if(/^\s*(not ok|ok) \d+ - /.test(lines[j]))break;
  }
 }
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>{
  const values=[...text.matchAll(new RegExp('^# '+k+' (\\d+)$','gm'))];return [k,values.length?Number(values.at(-1)[1]):null];
 }));
 if(counts.fail!==ids.size)throw Error(`${file}: ${counts.fail} failures, ${ids.size} identities`);
 return {counts,identities:[...ids].sort()};
}
const base=parse(baseline),cand=parse(candidate),minus=(a,b)=>a.filter(v=>!b.includes(v));
const report={baseline:base.counts,candidate:cand.counts,newFailures:minus(cand.identities,base.identities),resolvedFailures:minus(base.identities,cand.identities)};
mkdirSync(out,{recursive:true});
for(const [name,ids] of [['baseline',base.identities],['candidate',cand.identities]])writeFileSync(path.join(out,name+'.failures.txt'),ids.join('\n')+'\n');
writeFileSync(path.join(out,'failure-delta.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.newFailures.length||report.resolvedFailures.length)process.exitCode=1;
