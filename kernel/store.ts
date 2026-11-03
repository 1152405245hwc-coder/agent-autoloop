// The log on disk. `commit` is the only way a fact gets in, and it goes in with its projection or not at all.
import type { DatabaseSync } from "node:sqlite";
import { Conflict } from "./errors.ts";
import { empty, evolve, type Fact, type View } from "./evolve.ts";

export function readLog(db: DatabaseSync, after = 0): Fact[] {
  const rows = db.prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq").all(after);
  return rows.map((row) => JSON.parse(String(row.fact)));
}

function transaction(db: DatabaseSync, work: () => View): View {
  db.exec("BEGIN IMMEDIATE");
  try {
    const view = work();
    db.exec("COMMIT");
    return view;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const rebuild = (db: DatabaseSync) => transaction(db, () => evolve(empty(), readLog(db), db, true));

export function commit(db: DatabaseSync, view: View, facts: Fact[]): View {
  if (!facts.length) return view;
  return transaction(db, () => {
    const latest = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM facts").get()!.seq);
    if (latest !== view.seq) throw new Conflict("日志已变化，请重读后再提交");
    const insert = db.prepare("INSERT INTO facts(seq,fact) VALUES (?,?)");
    for (const fact of facts) insert.run(fact.seq, JSON.stringify(fact));
    return evolve(view, facts, db);
  });
}
