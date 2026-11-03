import type { DatabaseSync } from "node:sqlite";
import { empty, evolve, type View, type Fact } from "./evolve.ts";
import { Conflict } from "./errors.ts";

export const readLog = (db: DatabaseSync, after = 0): Fact[] => db.prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq").all(after).map(r => JSON.parse(String(r.fact)));
export function rebuild(db: DatabaseSync): View {
  db.exec("BEGIN IMMEDIATE");
  try { const view=evolve(empty(),readLog(db),db,true);db.exec("COMMIT");return view; }
  catch(error) {db.exec("ROLLBACK");throw error;}
}
export function commit(db: DatabaseSync, view: View, facts: Fact[]): View {
  if (!facts.length) return view;
  db.exec("BEGIN IMMEDIATE");
  try {
    const latest = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM facts").get()!.seq);
    if (latest !== view.seq) throw new Conflict("日志已变化，请重读后再提交");
    for (const fact of facts) db.prepare("INSERT INTO facts(seq,fact) VALUES (?,?)").run(fact.seq,JSON.stringify(fact));
    const next=evolve(view,facts,db);
    db.exec("COMMIT");
    return next;
  } catch(error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
