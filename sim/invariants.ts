import assert from "node:assert/strict";
import {empty,evolve,rows,type Fact,type View} from "../kernel/evolve.ts";
import {configuration} from "../kernel/query.ts";

export function invariants(view:View,log:Fact[],before?:View) {
  for(const [index,fact] of log.entries())assert.equal(fact.seq,index+1,"日志序号不连续");
  const events=rows(view,"events"),runs=rows(view,"runs"),cards=rows(view,"cards"),links=rows(view,"run_events");
  assert.equal(new Set(events.map(e=>JSON.stringify([e.source,e.key]))).size,events.length,"重复事件");
  const held=runs.filter(r=>r.state==="claimed");
  assert.equal(new Set(held.map(r=>JSON.stringify([r.grp,r.lane]))).size,held.length,"同一事项同时领了两轮");
  for(const group of new Set(held.map(r=>r.grp)))assert.ok(held.filter(r=>r.grp===group).length<=(configuration(view).rules.find(r=>r.group===group)?.parallel??1),"超出同组并发数");
  for(const e of events)for(const rule of JSON.parse(e.routed))assert.ok(links.some(l=>l.event_id===e.id&&view.tables.runs[l.run_id]?.rule===rule),"已收事件丢了派发关系");
  for(const card of cards)if(card.answer_event!==null){
    const event=view.tables.events[card.answer_event];assert.equal(event?.type,"card.answered");
    if(configuration(view).rules.some(r=>r.name===card.rule))assert.ok(links.some(l=>l.event_id===card.answer_event&&view.tables.runs[l.run_id]?.rule===card.rule&&view.tables.runs[l.run_id]?.lane===card.lane),"回答没叫醒原事项");
  }
  if(before){
    for(const e of rows(before,"events"))assert.deepEqual(view.tables.events[e.id],e,"已落盘事件被改了或丢了");
    for(const c of rows(before,"cards"))if(c.answer_event!==null){const now=view.tables.cards[c.id];assert.equal(now.answer_event,c.answer_event);assert.equal(now.choice,c.choice);assert.equal(now.answer,c.answer);}
    for(const r of rows(before,"runs"))if(["done","nothing","cancelled"].includes(r.state))assert.deepEqual(view.tables.runs[r.id],r,"完成的回执再次生效");
  }
  assert.deepEqual(evolve(empty(),log),view,"日志重放不同");
}
