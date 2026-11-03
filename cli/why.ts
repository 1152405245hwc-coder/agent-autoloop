import type { Fact, Row } from "../kernel/evolve.ts";

const time = (value: string | number) => new Date(value).toISOString().slice(0,19).replace("T"," ") + " UTC";
const eventText = (event: Row) => `来源 ${event.source} · 类型 ${event.type} · 对象 ${event.subject || "无"}`;

export function formatWhy(id: number, facts: Fact[]) {
  const all = facts.flatMap(f=>f.changes), relations = new Map<string, Row>();
  for (const change of all) if(change.table==="run_events") {
    if(change.row) relations.set(change.key,change.row); else relations.delete(change.key);
  }
  const events = new Set([...relations.values()].filter(r=>r.run_id===id).map(r=>r.event_id));
  const runs = all.filter(c=>c.table==="runs"&&c.row?.id===id).map(c=>c.row!);
  const links = new Map<number,string>();
  for(const run of runs) if(run.issued&&run.link) links.set(run.issued,run.link);
  const versions = new Set(runs.map(r=>r.rules_version));
  const configs = new Map(facts.filter(f=>f.type==="rules").map(f=>[f.seq,f.changes.find(c=>c.table==="config"&&c.key==="rules")!.row!.value]));
  const lines = [`第 ${id} 轮 · ${runs.at(-1)!.rule}`], previous = new Map<string, Row>(), started = new Set<number>();
  const add = (at: string | number, text: string) => lines.push(`${time(at)}  ${text}`);
  for (const fact of facts) {
    if(fact.type==="rules"&&versions.has(fact.seq)) add(fact.at,`规则版本 #${fact.seq}`);
    const changes = new Map(fact.changes.map(c=>[`${c.table}:${c.key}`,c]));
    const run = changes.get(`runs:${id}`)?.row;
    const receipt = fact.type==="finish"&&run;
    for (const [key,change] of changes) {
      const row=change.row, before=previous.get(key);
      if(change.table==="events"&&row&&!before&&events.has(row.id)) add(row.received_at,`触发事件：${eventText(row)}`);
      if(change.table==="runs"&&row?.id===id) {
        if(row.claimed_at&&row.claimed_at!==before?.claimed_at) {
          const agent=configs.get(row.rules_version).agents[row.agent];
          add(row.claimed_at,`${agent.worker} 领取（${agent.name}）`);
        }
        if(fact.type==="started"&&!started.has(row.issued)) { add(fact.at,"开始处理");started.add(row.issued); }
        if(row.link&&row.link===links.get(row.issued)&&row.link!==before?.link) add(fact.at,`会话：${row.link}`);
        if(row.finished_at&&row.finished_at!==before?.finished_at) add(row.finished_at,`结束：${row.summary || (row.state==="cancelled"?"已停止":"没有填写结论")}`);
        if(receipt&&row.state==="queued"&&row.attempts!==before?.attempts) add(fact.at,`本次未完成：${row.error}；重试时间 ${time(row.not_before)}`);
        if(receipt) for(const rejected of JSON.parse(row.last_answer ?? "[]")) add(fact.at,`未执行：${rejected.reason}`);
      }
      if(change.table==="cards"&&row) {
        if(!before&&row.run_id===id&&!row.fyi) {
          const options=JSON.parse(row.options) as string[];
          add(row.created_at,`${row.kind==="ask"?"提问":"通知"}：${row.title}`);
          if(row.text) lines.push(`  ${row.text}`);
          if(options.length) lines.push(`  选项：${options.join(" / ")}`);
        }
        if(row.decided_at&&row.decided_at!==before?.decided_at&&(row.run_id===id||events.has(row.answer_event))) {
          const answer=row.answer ?? JSON.parse(row.options)[row.choice];
          add(row.decided_at,`${row.by || "本人"}回答「${row.title}」：${answer}`);
          if(row.run_id===id) for(const next of [...relations.values()].filter(r=>r.event_id===row.answer_event&&r.run_id!==id)) add(row.decided_at,`回答后继续：第 ${next.run_id} 轮`);
        }
        if(row.state==="closed"&&before?.state!=="closed"&&(receipt||row.run_id===id)&&!row.fyi) add(row.closed_at,`结案：${row.title}；${row.result}`);
      }
      if(receipt&&change.table==="timers") add(fact.at,row?`安排复查：${row.about}；时间 ${time(row.at)}`:`取消复查：${before?.key ?? change.key}`);
      if(receipt&&change.table==="events"&&row&&!before&&!events.has(row.id)) add(fact.at,`发出事件：${eventText(row)}`);
      if(row) previous.set(key,row); else previous.delete(key);
    }
  }
  return lines.join("\n");
}
