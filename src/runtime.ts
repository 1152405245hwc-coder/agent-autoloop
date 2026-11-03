import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HOME, RULES_FILE } from "./home.ts";
import { decide } from "../kernel/decide.ts";
import { evolve, iso, type Row, type Table, type Fact } from "../kernel/evolve.ts";
import { commit, readLog, rebuild } from "../kernel/store.ts";
import * as query from "../kernel/query.ts";
import * as ruleChecks from "../kernel/rules.ts";
import { stateOf as state } from "../kernel/state.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import type { Job } from "../protocol/job.ts";

mkdirSync(HOME,{recursive:true,mode:0o700});
const master=join(HOME,"master.key");
if(!existsSync(master)) writeFileSync(master,randomBytes(32).toString("base64url"),{mode:0o600,flag:"wx"});
export const environment={secret:readFileSync(master,"utf8").trim(), publicUrl:process.env.AGENT_HUB_PUBLIC_URL ?? ""};
export const db=new DatabaseSync(join(HOME,"hub.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) throw new Error("这是旧版数据库；本轮未提供导入工具，请使用新的 AGENT_HUB_HOME");
db.exec("CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key));");
db.function("card_token",(id,at)=>query.credential(environment,"card",id,at));
const schema=readFileSync(new URL("../migrations/001_init.sql",import.meta.url),"utf8");
for(const match of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
  const [_,table,body]=match;
  const fields=[...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(m=>m[1]);
  const cols=fields.map(k=>k==="token" ? "card_token(json_extract(data,'$.id'),json_extract(data,'$.created_at')) AS token" : `json_extract(data,'$.${k}') AS ${k}`);
  db.exec(`CREATE VIEW IF NOT EXISTS ${table} AS SELECT ${cols.join(",")} FROM projections WHERE collection='${table}'`);
}
// The persisted projection is expendable; the log alone rebuilds it.
let current=rebuild(db);
export const all=<T>(sql:string,params:SQLInputValue[]=[])=>db.prepare(sql).all(...params).map(r=>({...r}) as T);
export const one=<T>(sql:string,params:SQLInputValue[]=[])=>{const r=db.prepare(sql).get(...params);return r ? {...r} as T : undefined;};
export function getView() { current=evolve(current,readLog(db,current.seq)); return current; }
const listeners=new Set<(type:string,facts:Fact[])=>void>();
export const onChange=(fn:(type:string,facts:Fact[])=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);};
export function execute(type:string,args:any[],now=Date.now()) {
  const d=decide(getView(),{type,args},now,environment); current=commit(db,current,d.facts);
  if(d.facts.length) for(const fn of listeners) fn(type,d.facts);
  return d.value;
}
export const parseRules=(json:string,now=Date.now())=>ruleChecks.parseRules(json,now,Intl.DateTimeFormat().resolvedOptions().timeZone);
export const {RulesError,typeMatches,eventRule,cronOf,SCHEDULE}=ruleChecks;
export let rules=query.configuration(current);
let loaded={file:"",mtime:0};
export function reloadRules(file=RULES_FILE) {
  const mtime=statSync(file).mtimeMs;
  if(loaded.file===file && loaded.mtime===mtime) return {changed:false};
  loaded={file,mtime};
  try {
    const next=parseRules(readFileSync(file,"utf8"));
    if(JSON.stringify(next)!==JSON.stringify(query.configuration(getView())) || Object.values(current.tables.cards).some(c=>c.key.startsWith("rules:") && c.state==="open")) execute("rules",[next]);
    rules=next; return {changed:true};
  } catch(error) { if(error instanceof RulesError) return {changed:false,problem:error.message};throw error; }
}
const initial=reloadRules();
if(!rules) throw new Error(initial.problem ?? "缺少规则");
export const ruleNamed=(name:string)=>rules.rules.find(r=>r.name===name);
export const rulesFor=(source:string,type:string)=>rules.rules.filter(r=>eventRule(r)&&r.when.source===source&&typeMatches(r.when.types,type));
export const workers=()=>[...new Set(Object.values(rules.agents).map(a=>a.worker))];
export const agentsOf=(worker:string)=>query.agentsOf(getView(),worker);
export const limitOf=(group:string)=>rules.rules.find(r=>r.group===group)?.parallel ?? 1;
export const ingest=(source:string,input:unknown,now=Date.now()):{event:number;duplicate:boolean;routed:string[]}=>execute("ingest",[source,input],now);
export const claimNext=(worker:string,claim:string,now=Date.now()):Job|null=>execute("claimNext",[worker,claim],now);
export const heartbeat=(worker:string,running:number[],now=Date.now())=>execute("heartbeat",[worker,running],now);
export const started=(run:number,token:string,input:unknown,now=Date.now())=>execute("started",[run,token,input],now);
export const finish=(run:number,token:string,input:unknown,now=Date.now()):{rejected:import("../protocol/validate.ts").Rejected[];duplicate?:boolean}=>execute("finish",[run,token,input],now);
export const cancel=(run:number,now=Date.now())=>execute("cancel",[run],now);
export const cancels=(worker:string)=>query.cancels(getView(),worker);
export const sweep=(now=Date.now())=>execute("sweep",[],now);
export function tick(now=Date.now()) { const r=reloadRules(); if(r.problem)execute("rulesError",[r.problem],now);execute("tick",[],now); }
export const createCard=(spec:Row,now=Date.now())=>execute("createCard",[spec],now);
export const tell=(key:string,title:string,text:string,now=Date.now()):{card:number;duplicate:boolean}=>execute("tell",[key,title,text],now);
export type Answer={choice?:number;text?:string;by?:string;channel?:string;ref?:string};
export const answer=(id:number,given:Answer,now=Date.now()):{changed:boolean;state:string}=>execute("answer",[id,given],now);
export const resolve=(id:number,reason:string,by:string,now=Date.now()):boolean=>execute("resolve",[id,reason,by],now);
export const nextCard=(channel:string,now=Date.now()):ReturnType<typeof query.cardView>|null=>execute("nextCard",[channel],now);
export const delivered=(channel:string,id:number,version:number,ref:string|null,now=Date.now())=>execute("delivered",[channel,id,version,ref],now);
export const failed=(channel:string,id:number,version:number,error:string,now=Date.now())=>execute("failed",[channel,id,version,error],now);
export const cardByToken=(token:string)=>Object.values(getView().tables.cards).find(c=>query.credential(environment,"card",c.id,c.created_at)===token);
export function cardAtLink(token:string) {const c=cardByToken(token);if(!c||!Object.values(rules.channels).some(c=>c.links))throw new NotFound("没有这张卡片");return c;}
export function answerByLink(token:string,given:Answer,now=Date.now()) {const c=cardAtLink(token);if(now-Date.parse(c.created_at)>7*86400_000)throw new AuthError(`这个链接过期了。在装它的电脑上运行 agent-hub answer ${c.id} 回答`);return answer(c.id,{...given,by:"链接"},now);}
export const view=(c:Row,ref:string|null=null,links=false)=>query.cardView(c,environment,ref,links);
export const unrouted=(limit=20)=>query.unrouted(getView(),limit);
export const stateOf=(now=Date.now(),before?:number)=>state(now,before,query.configuration(getView()),all,one,view,unrouted);
export type KeyKind="source"|"worker"|"channel"|"owner";
export const keepKeyHash=(kind:KeyKind,name:string,hash:string,now=Date.now())=>execute("key",[kind,name,hash],now);
export const addKey=(kind:KeyKind,name:string,now=Date.now())=>{const key=randomBytes(32).toString("base64url");keepKeyHash(kind,name,query.digest(key),now);return key;};
export const removeKey=(kind:KeyKind,name:string)=>execute("removeKey",[kind,name]);
export const listKeys=()=>all<{kind:string;name:string;created_at:string}>("SELECT kind,name,created_at FROM keys ORDER BY kind,name");
export const whose=(kind:string,key:string)=>query.whose(getView(),kind,key);
export const logAfter=(after=0)=>readLog(db,after).map(query.safeFact);
export function why(id:number) {
  const v=getView(), run=v.tables.runs[id];if(!run)throw new NotFound("没有这一轮");
  const events=new Set(query.eventsOf(v,id).map(e=>String(e.id)));
  const cards=new Set(Object.values(v.tables.cards).filter(c=>c.run_id===id || events.has(String(c.answer_event))).map(c=>String(c.id)));
  const log=logAfter(),versions=new Set(log.flatMap(f=>f.changes.filter(c=>c.table==="runs"&&c.key===String(id)&&c.row).map(c=>c.row!.rules_version)));
  return log.filter(f=>versions.has(f.seq) || f.changes.some((c:Row)=>c.table==="runs"&&c.key===String(id)||c.table==="events"&&events.has(c.key)||c.table==="cards"&&cards.has(c.key)));
}
// Test fixtures use this to discard rows without changing the behavioral assertions inherited from the SQL kernel.
export function fixtureClear(table:Table) {
  current=evolve(getView(),[{version:1,seq:current.seq,at:0,type:"fixture",changes:Object.keys(current.tables[table]).map(key=>({table,key,row:null}))}],db);
}
export { iso };
