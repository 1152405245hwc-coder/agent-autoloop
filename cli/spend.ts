// The cost line in `agent-hub status`, worked out from the runs /v1/state lists. Agents report usage for themselves, or
// don't: a plain command says nothing, and some give tokens but no price. So every figure says how many rounds it leaves out.
import { dayStart } from "../kernel/cron.ts";

type Usage = { input?: number; output?: number; cached?: number; cost?: number };
export type SpendingRun = { claimedAt: string | null; finishedAt: string | null; usage: Usage | null };

export const WEEK = 7 * 86400_000;
const count = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
/** To two places, a day on a cheap model would read as nothing at all. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

/** Rounds that ended, not those still going or waiting to try again; one stopped before it ever ran spent nothing. */
const endedSince = (runs: SpendingRun[], since: number) =>
  runs.filter((run) => run.finishedAt && (run.claimedAt || run.usage) && Date.parse(run.finishedAt) >= since);

function figure(runs: SpendingRun[], reported: (usage: Usage) => number | undefined) {
  const amounts = runs.flatMap((run) => reported(run.usage ?? {}) ?? []);
  return { total: amounts.reduce((sum, amount) => sum + amount, 0), silent: runs.length - amounts.length };
}

function tally(label: string, runs: SpendingRun[]) {
  if (!runs.length) return `${label} 0 轮`;
  const tokens = figure(runs, ({ input, output }) =>
    input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0),
  );
  const cost = figure(runs, (usage) => usage.cost);
  const missing = (silent: number) => (silent ? `（${silent} 轮没上报）` : "");
  const shownTokens =
    tokens.silent === runs.length
      ? "Token 没上报"
      : `${count.format(tokens.total).replace(/(万|亿)/, " $1")} Token${missing(tokens.silent)}`;
  const shownCost = cost.silent === runs.length ? "费用没上报" : `${dollars(cost.total)}${missing(cost.silent)}`;
  return `${label} ${runs.length} 轮 · ${shownTokens} · ${shownCost}`;
}

export function spendLine(runs: SpendingRun[], now: number, timezone: string) {
  const today = tally("今天", endedSince(runs, dayStart(now, timezone)));
  return `${today}    ${tally("最近 7 天", endedSince(runs, now - WEEK))}`;
}
