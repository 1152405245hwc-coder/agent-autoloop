import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cpSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const edits:[string,string,string,string][]=[
  ["event-duplicate","decide.ts","if (existing) return { event:","if (false && existing) return { event:"],
  ["source-boundary","decide.ts","r.when.source === source","true"],
  ["parallel-lane","decide.ts","const lane = rule.parallel ? subject : \"\"","const lane = \"\""],
  ["group-capacity","decide.ts","going.filter(g => g.grp === r.grp).length <","0 <"],
  ["lane-exclusion","decide.ts","!going.some(g => g.grp === r.grp && g.lane === r.lane)","true"],
  ["worker-boundary","decide.ts","r.state === \"queued\" && agents.includes(r.agent)","r.state === \"queued\" && true"],
  ["retry-delay","decide.ts","5*MINUTE*2**(attempts-1)","0*MINUTE*2**(attempts-1)"],
  ["receipt-replay","decide.ts","if (prior?.last_issued !== null && prior &&","if (false && prior?.last_issued !== null && prior &&"],
  ["receipt-conflict","decide.ts","if (prior.last_result!==hash)","if (false)"],
  ["run-capability","decide.ts","credential(env,\"run\",id,r.issued) !== token","false"],
  ["answer-first","decide.ts","if(card.state!==\"open\")","if(false)"],
  ["answer-person","decide.ts","if(allowed && !allowed.includes(given.by ?? \"\"))","if(false)"],
  ["answer-message","decide.ts","if(!d?.ref || d.ref!==given.ref)","if(false)"],
  ["answer-wakeup","decide.ts","if(rule) queue(rule,id,card.lane,","if(false) queue(rule,id,card.lane,"],
  ["quiet-delivery","decide.ts","if(c.quiet ||","if(false ||"],
  ["delivery-lease","decide.ts","not_before:iso(now+MINUTE)","not_before:iso(now)"],
  ["delivery-version","decide.ts","version:Math.max(d.version,version)","version:version"],
  ["timer-fire","decide.ts","filter(t=>t.event_id===null && Date.parse(t.at)<=now)","filter(t=>t.event_id!==null && Date.parse(t.at)<=now)"],
  ["cron-latest","decide.ts","latestBefore(cron,Date.parse(s.next_at),now,rules().timezone)","Date.parse(s.next_at)"],
  ["retry-deadline","due.ts","Date.parse(r.not_before)>now","Date.parse(r.not_before)<now"],
  ["projection-drop","evolve.ts","if (row === null)","if (row === null || table === \"cards\")"],
  ["log-order","store.ts","ORDER BY seq","ORDER BY seq DESC"],
  ["stale-commit","store.ts","if (latest !== view.seq)","if (false)"],
  ["log-append","store.ts","for (const fact of facts) db.prepare","for (const fact of []) db.prepare"],
];
const tests=["kernel","events","cards","runs","schedule","stream","purity"].map(n=>`tests/${n}.test.ts`);
export function mutate() {
  const root=join(import.meta.dirname,".."),folder=mkdtempSync(join(tmpdir(),"agent-hub-mutation-"));
  // An inherited test-runner context bypasses the child CLI's test selection.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=()=>spawnSync(process.execPath,["--disable-warning=ExperimentalWarning","--test","--test-reporter=tap",...tests],{cwd:folder,env,encoding:"utf8",timeout:30000});
  try {
    for(const name of ["kernel","protocol","src","tests","migrations","package.json"])cpSync(join(root,name),join(folder,name),{recursive:true});
    symlinkSync(join(root,"node_modules"),join(folder,"node_modules"));
    const baseline=run();assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
    assert.ok(Number(/# tests (\d+)/.exec(baseline.stdout)?.[1])>50,"基线必须确实执行行为测试");
    const mutations=edits.map(([name,file,before,after])=>({name,file,change:(text:string)=>{assert.ok(text.includes(before),name);return text.replace(before,after);}}));
    mutations.push({name:"transaction-removed",file:"store.ts",change:text=>{const at=text.indexOf("export function commit");return text.slice(0,at)+text.slice(at).replaceAll('db.exec("BEGIN IMMEDIATE")','db.exec("SELECT 1")').replaceAll('db.exec("COMMIT")','db.exec("SELECT 1")').replaceAll('db.exec("ROLLBACK")','db.exec("SELECT 1")');}});
    const survived:string[]=[],invalid:string[]=[];let killed=0;
    for(const mutation of mutations) {
      const file=join(folder,"kernel",mutation.file),original=readFileSync(file,"utf8");
      try {
        writeFileSync(file,mutation.change(original));
        const syntax=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
        if(syntax.status!==0){invalid.push(mutation.name);continue;}
        const result=run();if(result.status===0)survived.push(mutation.name);else {assert.ok(!result.error,`${mutation.name}: ${result.error}`);killed++;}
        console.log(`${mutation.name}: ${result.status===0?"漏过":"抓到"}`);
      } finally {writeFileSync(file,original);}
    }
    return {total:mutations.length,killed,survived,invalid,ratio:killed/mutations.length};
  } finally {rmSync(folder,{recursive:true,force:true});}
}
if(import.meta.main)console.log(JSON.stringify(mutate(),null,2));
