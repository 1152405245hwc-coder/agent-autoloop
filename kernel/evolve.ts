// The view: every table as of some point in the log, and `evolve` alone changes it. Records in facts are values, not
// commands: replay never consults current rules or re-runs business decisions.
import type { DatabaseSync } from "node:sqlite";

export type Row = Record<string, any>;
const BUSINESS_TABLES = ["events", "runs", "run_events", "cards", "deliveries", "timers"] as const;
const BOOKKEEPING_TABLES = ["schedules", "seen", "keys", "config", "due"] as const;
export type Table = (typeof BUSINESS_TABLES)[number] | (typeof BOOKKEEPING_TABLES)[number];
export type Change = { table: Table; key: string; row: Row | null };
export type Fact = { version: 1; seq: number; at: number; type: string; changes: Change[]; meta?: Row };
export type View = { seq: number; tables: Record<Table, Record<string, Row>>; next: Record<string, number> };

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function empty(): View {
  const tables = [...BUSINESS_TABLES, ...BOOKKEEPING_TABLES].map((table) => [table, {}]);
  return freeze({ seq: 0, tables: Object.fromEntries(tables) as View["tables"], next: {} });
}

export function evolve(view: View, facts: Fact[], db?: DatabaseSync, reset = false): View {
  if (reset) db?.exec("DELETE FROM projections");
  const result = { seq: view.seq, tables: { ...view.tables }, next: { ...view.next } };
  const copied = new Set<Table>();
  for (const fact of facts) {
    result.seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (!copied.has(table)) {
        result.tables[table] = { ...result.tables[table] };
        copied.add(table);
      }
      if (row === null) {
        delete result.tables[table][key];
        db?.prepare("DELETE FROM projections WHERE collection=? AND key=?").run(table, key);
      } else {
        result.tables[table][key] = freeze(row);
        if (typeof row.id === "number") result.next[table] = Math.max(result.next[table] ?? 0, row.id);
        db?.prepare(
          "INSERT INTO projections VALUES (?,?,?) ON CONFLICT(collection,key) DO UPDATE SET data=excluded.data",
        ).run(table, key, JSON.stringify(row));
      }
    }
  }
  for (const table of copied) Object.freeze(result.tables[table]);
  return Object.freeze({ ...result, tables: Object.freeze(result.tables), next: Object.freeze(result.next) });
}

export const rows = (view: View, table: Table): Row[] => Object.values(view.tables[table]);
export const iso = (ms: number) => new Date(ms).toISOString();
