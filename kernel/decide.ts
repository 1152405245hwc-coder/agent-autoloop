import { evolve, rows, iso, type View, type Row, type Table, type Change, type Fact } from "./evolve.ts";
import { agentsOf, configuration, credential, digest, jobOf, openInScope, sourceOf, cardView, eventsOf, type Environment } from "./query.ts";
import { eventRule, cronOf, typeMatches, type Rule } from "./rules.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { parseEvent, parseResult, type Rejected } from "../protocol/validate.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";

import { deadlines } from "./due.ts";

export type Input = { type: string; args: any[] };
const MINUTE = 60_000, DAY = 86400_000, TRY_AT = [0,1,3,7,15,25,35,45,55];
const defaults: Partial<Record<Table, Row>> = {
  runs: { attempts: 0, claim: null, issued: null, last_issued: null, last_result: null, last_answer: null, cancel_at: null, resume: null, session: null, link: null, claimed_at: null, seen_at: null, finished_at: null, summary: null, error: null, usage: null },
  cards: { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0, choice: null, answer: null, by: null, result: null, rule: null, lane: "", grp: null, source: null, agent: null, session: null, run_id: null, answer_event: null, version: 1, decided_at: null, closed_at: null },
  deliveries: { version: 0, ref: null, tries: 0, first_try_at: null, not_before: null, error: null, given_up: 0 },
};
export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  let draft = view;
  const changes: Change[] = [];
  const fact = (change: Change): Fact => ({ version: 1, seq: view.seq+1, at: now, type: input.type, changes: [change] });
  const set = (table: Table, key: string | number, row: Row | null) => {
    const change = { table, key: String(key), row }; changes.push(change); draft = evolve(draft, [fact(change)]); return row!;
  };
  const put = (table: Table, key: string | number, fields: Row) => set(table, key, { ...defaults[table], ...draft.tables[table][key], ...fields });
  const add = (table: Table, fields: Row) => { const id = (draft.next[table] ?? 0)+1; return put(table, id, { ...fields, id }); };
  const list = (table: Table) => rows(draft, table);
  const rules = () => configuration(draft);
  const named = (name: string) => rules().rules.find(r => r.name === name);
  const close = (c: Row, result: string, by: string | null = null) => put("cards", c.id, { state: "closed", result, by: by ?? c.by, closed_at: iso(now), version: c.version+1 });
  const closeKey = (key: string, text: string) => { for (const c of list("cards").filter(c => c.key === key && c.state === "open")) close(c,text); };
  const card = (spec: Row) => {
    const existing = list("cards").findLast(c => c.key === spec.key && (spec.once || c.state === "open"));
    if (existing) return { card: existing.id, duplicate: true };
    const { once, run, options, fyi, quiet, ...fields } = spec;
    const c = add("cards", { ...fields, run_id: run ?? null, options: JSON.stringify(options ?? []), fyi: fyi ? 1 : 0, quiet: quiet ? 1 : 0, state: fyi ? "closed" : "open", created_at: iso(now) });
    return { card: c.id, duplicate: false };
  };
  const queue = (rule: Rule, event: number, subject: string, resume?: string | null) => {
    const lane = rule.parallel ? subject : "";
    let run = list("runs").find(r => r.rule === rule.name && r.lane === lane && r.state === "queued");
    run ??= add("runs", { rule: rule.name, agent: rule.to, grp: rule.group, lane, state: "queued", not_before: iso(now), created_at: iso(now), rules_version: draft.tables.config.rules.version });
    put("run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
    if (resume) put("runs", run.id, { resume });
  };
  const keep = (source: string, e: Row, routed: string[]) => {
    let key=e.id;
    for(let suffix=1;list("events").some(old=>old.source===source&&old.key===key);suffix++)key=`${e.id}:${suffix}`;
    return add("events", { source, key, type: e.type, subject: e.subject ?? "", summary: e.summary ?? "", detail: e.detail ?? "", link: e.link ?? "", hops:e.hops??0,routed: JSON.stringify(routed), received_at: iso(now) }).id as number;
  };
  const ingest = (source: string, given: unknown) => {
    const e = parseEvent(given);
    const existing = list("events").find(r => r.source === source && r.key === e.id);
    if (existing) return { event: existing.id, duplicate: true, routed: JSON.parse(existing.routed) };
    const matched = e.hops>8?[]:rules().rules.filter(r => eventRule(r) && r.when.source === source && typeMatches(r.when.types, e.type));
    const routed = matched.map(r => r.name), id = keep(source,e,routed);
    if(e.hops>8)card({key:`hops:${source}:${e.id}`,kind:"notice",title:"事件循环已停止",text:"同一条处理链已超过 8 层，后续事件已记录，没有继续派发。",once:true});
    for (const rule of matched) queue(rule,id,e.subject);
    return { event: id, duplicate: false, routed };
  };
  const holding = (id: number, token: string, states: string[]) => {
    const r = draft.tables.runs[id];
    if (!r || !states.includes(r.state) || r.issued === null || credential(env,"run",id,r.issued) !== token) throw new AuthError("这件活不归这个令牌");
    return r;
  };
  const depth=(r:Row)=>Math.max(0,...eventsOf(draft,r.id).map(e=>e.hops??0));
  const makeReceiptCard = (r: Row, rule: Rule | undefined, kind: string, c: Row) => card({ ...c, hops:depth(r),key: `thread:${r.rule}:${r.lane}:${c.key ?? digest(`${c.title}\n${c.text}`).slice(0,32)}`, kind,
    quiet: kind === "notice" && rule?.tell === "never", rule: r.rule, lane: r.lane, grp: r.grp, source: sourceOf(draft,r.id), agent: r.agent, session: draft.tables.runs[r.id].session, run: r.id });
  const sweep = () => {
    for (const worker of new Set(Object.values(rules().agents).map(a => a.worker))) {
      const agents = agentsOf(draft,worker), seen = draft.tables.seen[`worker:${worker}`], last = seen ? Date.parse(seen.seen_at) : undefined;
      if (last !== undefined && now-last <= 2*MINUTE) {
        for (const c of list("cards").filter(c => c.key.startsWith(`worker:${worker}:offline:`) && c.state === "open")) close(c,"连上了");
        for (const r of list("runs").filter(r => r.state === "claimed" && agents.includes(r.agent) && Date.parse(r.seen_at) < now-5*MINUTE)) {
          put("runs",r.id,{ state: "unknown" });
          card({ key: `run:${r.id}:unknown`, kind: "notice", title: r.rule, text: `交给 ${rules().agents[r.agent].name} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。`, rule:r.rule,lane:r.lane,grp:r.grp });
        }
      }
      const waiting = list("runs").filter(r => agents.includes(r.agent) && (r.state === "claimed" || (r.state === "queued" && Date.parse(r.not_before)<=now)));
      if (!waiting.length) continue;
      const since = now-(last ?? Date.parse(waiting[0].created_at));
      if (since <= 10*MINUTE) continue;
      card({ key:`worker:${worker}:offline:${last === undefined ? "never" : iso(last)}`, kind:"notice", title:"接单程序没连上", text: last === undefined
        ? `${worker} 一直没连上中台，有 ${waiting.length} 件任务等了 ${Math.floor(since/MINUTE)} 分钟没人接（请看一眼那台电脑有没有开机联网）。`
        : `${worker} 已经 ${Math.floor(since/MINUTE)} 分钟没连上中台，有 ${waiting.length} 件任务在排队或在跑（请看一眼那台电脑是不是关机、休眠或断网了）。` });
    }
  };
  const [a,b,c] = input.args;
  let value: any;
  switch (input.type) {
    case "rules":
      put("config","rules",{ value:a, version:view.seq+1 });
      for (const card of list("cards").filter(c => c.key.startsWith("rules:") && c.state === "open")) close(card,"改好了");
      break;
    case "rulesError": value = card({ key:`rules:${digest(a)}`,kind:"notice",title:"rules.json 写错了，还在用旧规则",text:a }); break;
    case "key": put("keys",`${a}:${b}`,{ kind:a,name:b,hash:c,created_at:iso(now) }); break;
    case "removeKey": set("keys",`${a}:${b}`,null); break;
    case "ingest": value = ingest(a,b); break;
    case "createCard": value = card(a); break;
    case "tell": {
      value = card({ key:a,title:b,text:c,kind:"notice",fyi:true,once:true });
      if (!value.duplicate) break;
      const retry = list("deliveries").filter(d => d.card_id === value.card && d.given_up);
      for (const d of retry) put("deliveries",`${d.card_id}:${d.channel}`,{ given_up:0, tries:0, first_try_at:null, not_before:null });
      if (retry.length) { put("cards",value.card,{ text:c,created_at:iso(now) }); value.duplicate=false; }
      break;
    }
    case "heartbeat":
      put("seen",`worker:${a}`,{ kind:"worker",name:a,seen_at:iso(now) });
      for (const c of list("cards").filter(c => c.key.startsWith(`worker:${a}:offline:`) && c.state === "open")) close(c,"连上了");
      for (const id of b) { const r = draft.tables.runs[id]; if (r?.state === "claimed" && agentsOf(draft,a).includes(r.agent)) put("runs",id,{seen_at:iso(now)}); }
      break;
    case "channelSeen": put("seen",`channel:${a}`,{kind:"channel",name:a,seen_at:iso(now)}); break;
    case "claimNext": {
      const agents = agentsOf(draft,a), going=list("runs").filter(r => r.state === "claimed");
      const held = going.find(r => r.claim === b && agents.includes(r.agent));
      const r = held ?? list("runs").find(r => r.state === "queued" && agents.includes(r.agent) && Date.parse(r.not_before)<=now && named(r.rule)
        && !going.some(g => g.grp === r.grp && g.lane === r.lane) && going.filter(g => g.grp === r.grp).length < (rules().rules.find(x => x.group===r.grp)?.parallel ?? 1));
      if (!r) { value=null; break; }
      put("runs",r.id,{state:"claimed",claim:b,issued:view.seq+1,last_issued:null,last_result:null,last_answer:null,claimed_at:held ? r.claimed_at : iso(now),seen_at:iso(now),link:held ? r.link : null,rules_version:draft.tables.config.rules.version});
      value=jobOf(draft,draft.tables.runs[r.id],env); break;
    }
    case "started": {
      const given=c ?? {};
      for (const k of ["session","link"]) if (given[k] !== undefined && (typeof given[k]!=="string" || given[k].length>500)) throw new InputError(`${k} 要是 500 字以内的文字`);
      const r=holding(a,b,["claimed"]); put("runs",a,{session:given.session ?? r.session,link:given.link ?? r.link,seen_at:iso(now)}); break;
    }
    case "finish": {
      const hash=digest(JSON.stringify(c ?? null)), prior=draft.tables.runs[a];
      if (prior?.last_issued !== null && prior && credential(env,"run",a,prior.last_issued)===b) {
        if (prior.last_result!==hash) throw new Conflict("这一次执行已经交过不一样的结果");
        value={rejected:JSON.parse(prior.last_answer ?? "[]"),duplicate:true}; break;
      }
      const r=holding(a,b,["claimed","unknown"]), result=parseResult(c), rule=named(r.rule), rejected: Rejected[]=[];
      put("runs",a,{last_issued:r.issued,last_result:hash,issued:null,session:result.session ?? r.session,usage:result.usage ? JSON.stringify(result.usage) : r.usage});
      if (result.outcome === "failed") {
        const attempts=r.attempts+1, notBefore=now+Math.min(5*MINUTE*2**(attempts-1),60*MINUTE), error=(result.error ?? "").trim().replace(/[。.]+$/,"") || "没说原因";
        put("runs",a,{state:"queued",attempts,not_before:iso(notBefore),claim:null,claimed_at:null,seen_at:null,error,cancel_at:null});
        for (const other of list("runs").filter(o => o.id!==a && o.rule===r.rule && o.lane===r.lane && o.state==="queued")) {
          for (const e of list("run_events").filter(e => e.run_id===other.id)) { put("run_events",`${a}:${e.event_id}`,{run_id:a,event_id:e.event_id}); set("run_events",`${other.id}:${e.event_id}`,null); }
          set("runs",other.id,null); if(other.resume) put("runs",a,{resume:other.resume});
        }
        for(const what of ["ask","resolve","later","events"] as const) for(const _ of result[what] ?? []) rejected.push({what,reason:"没跑成的一轮只能发通知"});
        for(const n of result.notice ?? []) makeReceiptCard(r,rule,"notice",n);
        if(!result.notice?.length && attempts===3) {
          const time=new Intl.DateTimeFormat("zh-CN",{timeZone:rules().timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(notBefore);
          card({key:`run:${a}:failing`,kind:"notice",title:r.rule,text:`连续 3 次自动处理没跑完（卡在：${error}），${time} 会自动再试。`,rule:r.rule,lane:r.lane,grp:r.grp});
        }
      } else if(result.outcome==="cancelled") put("runs",a,{state:"cancelled",finished_at:iso(now),summary:result.summary ?? "",cancel_at:null});
      else {
        put("runs",a,{state:result.outcome,finished_at:iso(now),summary:result.summary ?? "",error:null,cancel_at:null});
        closeKey(`run:${a}:failing`,"后来跑成了"); closeKey(`run:${a}:unknown`,"结果回来了");
        const ids=list("run_events").filter(e=>e.run_id===a).map(e=>e.event_id);
        for(const c of list("cards").filter(c=>c.state==="decided" && ids.includes(c.answer_event))) put("cards",c.id,{state:"done",result:result.summary ?? "",closed_at:iso(now),version:c.version+1});
        for(const item of result.resolve ?? []) {
          const c=openInScope(draft,r).find(c=>c.id===item.card);
          if(c) close(c,item.reason.trim(),`第 ${a} 轮`); else rejected.push({card:item.card,reason:"不在本轮核对范围"});
        }
        for(const ask of result.ask ?? []) makeReceiptCard(r,rule,"ask",ask);
        for(const notice of result.notice ?? []) makeReceiptCard(r,rule,"notice",notice);
        if(rule?.tell==="always" && result.outcome==="done") card({key:`run:${a}:done`,kind:"notice",fyi:true,once:true,title:r.rule,text:result.summary ?? "",rule:r.rule,lane:r.lane,grp:r.grp,source:sourceOf(draft,a),run:a});
        for(const timer of result.later ?? []) {
          const p=list("timers").find(t=>t.rule===r.rule && t.lane===r.lane && t.key===timer.key && t.event_id===null);
          if(timer.cancel) { if(p) set("timers",p.id,null); }
          else {
            const fields={at:iso(Date.parse(timer.at!)),about:timer.about,session:draft.tables.runs[a].session,hops:depth(r)};
            if(p) put("timers",p.id,fields); else add("timers",{...fields,rule:r.rule,lane:r.lane,key:timer.key,source:sourceOf(draft,a) ?? "schedule",event_id:null,created_at:iso(now)});
          }
        }
        for(const event of result.events ?? []) {
          if(rule?.emits && typeMatches(rule.emits.types,event.type)) ingest(rule.emits.source,{...event,hops:depth(r)+1});
          else rejected.push({what:"events",reason:`规则「${r.rule}」没有写可以发 ${event.type}`});
        }
      }
      put("runs",a,{last_answer:JSON.stringify(rejected)}); value={rejected}; break;
    }
    case "cancel": {
      const r=draft.tables.runs[a]; if(!r) throw new NotFound("没有这一轮");
      if(r.state==="queued") put("runs",a,{state:"cancelled",finished_at:iso(now)});
      else if(r.state==="claimed") put("runs",a,{cancel_at:iso(now)}); else throw new InputError("这一轮已经结束了");
      break;
    }
    case "resolve": {
      const c=draft.tables.cards[a]; if(!c) throw new NotFound("没有这张卡片");
      value=c.state==="open"; if(value) close(c,b,input.args[2]); break;
    }
    case "answer": {
      const card=draft.tables.cards[a], given=b; if(!card) throw new NotFound("没有这张卡片");
      if(given.channel!==undefined) {
        const allowed=rules().channels[given.channel]?.answerers;
        if(allowed && !allowed.includes(given.by ?? "")) throw new AuthError("这个人不能回答这张卡片");
        const d=draft.tables.deliveries[`${a}:${given.channel}`];
        if(!d?.ref || d.ref!==given.ref) throw new AuthError("不是发出去的那条消息");
      }
      if(card.state!=="open") {value={changed:false,state:card.state};break;}
      if(card.kind==="notice") {close(card,"已处理",given.by ?? null);value={changed:true,state:"closed"};break;}
      if(given.text!==undefined && typeof given.text!=="string") throw new InputError("回答要是文字");
      const text=given.text?.trim() || null, options=JSON.parse(card.options);
      if(given.choice===undefined ? !text : !(Number.isInteger(given.choice) && given.choice>=0 && given.choice<options.length)) throw new InputError("没有这个选项");
      const rule=card.rule ? named(card.rule) : undefined;
      const id=keep(card.source ?? "schedule",{id:`card:${a}`,type:"card.answered",subject:card.lane,summary:card.title,hops:card.hops??0},rule ? [rule.name] : []);
      put("cards",a,{state:"decided",choice:given.choice ?? null,answer:text,by:given.by ?? null,decided_at:iso(now),answer_event:id,version:card.version+1});
      if(rule) queue(rule,id,card.lane,card.agent===rule.to ? card.session : null);
      value={changed:true,state:"decided"};break;
    }
    case "nextCard": {
      value=null;
      for(const c of list("cards")) {
        const d=draft.tables.deliveries[`${c.id}:${a}`] ?? defaults.deliveries!;
        if(c.quiet || d.version>=c.version || d.given_up || (d.not_before && Date.parse(d.not_before)>now) || !(c.state==="open" || d.ref!==null || (c.fyi && Date.parse(c.created_at)>=now-DAY))) continue;
        if(d.tries>=TRY_AT.length || (d.first_try_at && now-Date.parse(d.first_try_at)>57*MINUTE)) {put("deliveries",`${c.id}:${a}`,{given_up:1});continue;}
        put("deliveries",`${c.id}:${a}`,{card_id:c.id,channel:a,tries:d.tries+1,first_try_at:d.first_try_at ?? iso(now),not_before:iso(now+MINUTE)});
        value=cardView(c,env,d.ref,rules().channels[a]?.links===true);break;
      }
      break;
    }
    case "delivered": {
      const [channel,id,version,ref]=input.args;
      if(!draft.tables.cards[id]) throw new NotFound("没有这张卡片");
      const d=draft.tables.deliveries[`${id}:${channel}`] ?? defaults.deliveries!;
      put("deliveries",`${id}:${channel}`,{card_id:id,channel,version:Math.max(d.version,version),ref:d.ref ?? ref,tries:0,first_try_at:null,not_before:null,error:null});break;
    }
    case "failed": {
      const [channel,id,version,error]=input.args, c=draft.tables.cards[id], d=draft.tables.deliveries[`${id}:${channel}`];
      if(!c || !d) throw new NotFound("这张卡片没有交给这个通道");
      const fields=version<c.version ? {not_before:null} : d.tries>=TRY_AT.length ? {given_up:1} : {not_before:iso((d.first_try_at ? Date.parse(d.first_try_at):now)+TRY_AT[d.tries]*MINUTE)};
      put("deliveries",`${id}:${channel}`,{...fields,error:String(error).slice(0,300)});break;
    }
    case "sweep": sweep();break;
    case "tick": {
      for(const rule of rules().rules) {
        if(eventRule(rule)) continue;
        const text=cronOf(rule), cron=parseCron(text)!, s=draft.tables.schedules[rule.name];
        if(!s || s.cron!==text) {put("schedules",rule.name,{rule:rule.name,cron:text,next_at:iso(nextRun(cron,now,rules().timezone)!)});continue;}
        if(now<Date.parse(s.next_at)) continue;
        const key=`${rule.name}@${iso(latestBefore(cron,Date.parse(s.next_at),now,rules().timezone))}`;
        if(!list("events").some(e=>e.source==="schedule" && e.key===key)) queue(rule,keep("schedule",{id:key,type:"schedule.tick"},[rule.name]),"");
        put("schedules",rule.name,{next_at:iso(nextRun(cron,now,rules().timezone)!)});
      }
      for(const t of list("timers").filter(t=>t.event_id===null && Date.parse(t.at)<=now).sort((a,b)=>a.at.localeCompare(b.at))) {
        const rule=named(t.rule), id=keep(t.source,{id:`timer:${t.id}`,type:"timer.due",subject:t.lane,hops:t.hops??0},rule ? [rule.name] : []);
        put("timers",t.id,{event_id:id}); if(rule) queue(rule,id,t.lane,t.session);
      }
      sweep();break;
    }
    default: throw new InputError(`不认识的输入：${input.type}`);
  }
  const due=deadlines(draft,now);
  for(const [key,row] of Object.entries(due)) if(JSON.stringify(draft.tables.due[key])!==JSON.stringify(row))put("due",key,row);
  for(const key of Object.keys(draft.tables.due)) if(!due[key])set("due",key,null);
  return {facts:changes.length ? [{version:1,seq:view.seq+1,at:now,type:input.type,changes}] : [],value};
}
