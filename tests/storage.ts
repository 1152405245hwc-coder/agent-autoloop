// Fixture resets only; production writes go through decide/commit/evolve.
import { fixtureClear } from "../src/runtime.ts";
import type { Table } from "../kernel/evolve.ts";
export { all, one } from "../src/runtime.ts";
export const run = (sql: string) => { const match = /^DELETE FROM (\w+)$/.exec(sql); if (!match) throw new Error(sql); fixtureClear(match[1] as Table); };
