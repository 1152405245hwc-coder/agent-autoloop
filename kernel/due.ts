import { rows, type View, type Row } from "./evolve.ts";
import { configuration, agentsOf } from "./query.ts";
export function deadlines(v:View,now:number) {
  const due:Record<string,Row>={};
  const add=(kind:string,key:string,at:number)=>{due[`${kind}:${key}`]={kind,key,at};};
  for(const s of rows(v,"schedules")) if(configuration(v).rules.some(r=>r.name===s.rule && "cron" in r.when)) add("cron",s.rule,Date.parse(s.next_at));
  for(const t of rows(v,"timers")) if(t.event_id===null)add("later",String(t.id),Date.parse(t.at));
  for(const r of rows(v,"runs")) if(r.state==="queued" && Date.parse(r.not_before)>now)add("retry",String(r.id),Date.parse(r.not_before));
  for(const d of rows(v,"deliveries")) if(!d.given_up && d.not_before && Date.parse(d.not_before)>now)add("delivery",`${d.card_id}:${d.channel}`,Date.parse(d.not_before));
  for(const worker of new Set(Object.values(configuration(v)?.agents ?? {}).map(a=>a.worker))) {
    const agents=agentsOf(v,worker),seen=v.tables.seen[`worker:${worker}`];
    const waiting=rows(v,"runs").filter(r=>agents.includes(r.agent) && (r.state==="claimed" || r.state==="queued" && Date.parse(r.not_before)<=now));
    if(!waiting.length)continue;
    const key=`worker:${worker}:offline:${seen ? seen.seen_at : "never"}`;
    if(!rows(v,"cards").some(c=>c.key===key && c.state==="open"))add("offline",worker,Math.max(now,Date.parse(seen?.seen_at ?? waiting[0].created_at)+600001));
    if(seen && now-Date.parse(seen.seen_at)<=120000) for(const r of waiting.filter(r=>r.state==="claimed")) {
      const at=Math.max(now,Date.parse(r.seen_at)+300001);
      if(at<=Date.parse(seen.seen_at)+120000)add("lease",String(r.id),at);
    }
  }
  return due;
}
