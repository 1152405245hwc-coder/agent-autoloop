// What's going on, for the owner's own clients, read from what's actually there: rules, cards, runs and who has been seen.
import { describeCron, dayStart, nextRun, parseCron } from "./cron.ts";
import { iso, type Row } from "./evolve.ts";
import type { SQLInputValue } from "node:sqlite";
import { cardView } from "./query.ts";
import type { Rules } from "./rules.ts";

import { cronOf, eventRule } from "./rules.ts";
const ONLINE = 120_000;

const PAGE = 60;

type RunRow = {
  id: number; rule: string; agent: string; grp: string; lane: string; state: string; attempts: number; not_before: string; created_at: string;
  claimed_at: string | null; finished_at: string | null; summary: string | null; error: string | null; link: string | null; session: string | null; usage: string | null; cancel_at: string | null;
};

const COLUMNS = "id, rule, agent, grp, lane, state, attempts, not_before, created_at, claimed_at, finished_at, summary, error, link, session, usage, cancel_at";

export function stateOf(now: number, before: number | undefined, rules: Rules,
  all: <T>(sql: string, params?: SQLInputValue[]) => T[],
  one: <T>(sql: string, params?: SQLInputValue[]) => T | undefined,
  view: (card: Row) => ReturnType<typeof cardView>, unrouted: () => Row[]) {
  const today = iso(dayStart(now, rules.timezone));
  const seen = new Map(all<{ kind: string; name: string; seen_at: string }>("SELECT kind, name, seen_at FROM seen").map((s) => [`${s.kind}:${s.name}`, s.seen_at]));
  const online = (at: string | undefined) => at !== undefined && now - Date.parse(at) <= ONLINE;
  const counts = all<{ rule: string; agent: string; state: string; retrying: number; count: number; today: number; input: number; output: number; cost: number }>(
    `SELECT rule, agent, state, SUM(CASE WHEN state = 'queued' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying, COUNT(*) AS count,
            SUM(CASE WHEN state = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS today,
            COALESCE(SUM(json_extract(usage, '$.input')), 0) AS input, COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output, COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost
       FROM runs GROUP BY rule, agent, state`, [today]);
  const tally = (rows: typeof counts) => ({
    running: rows.filter((r) => r.state === "claimed").reduce((n, r) => n + r.count, 0),
    queued: rows.filter((r) => r.state === "queued").reduce((n, r) => n + r.count, 0),
    retrying: rows.reduce((n, r) => n + r.retrying, 0),
    unknown: rows.filter((r) => r.state === "unknown").reduce((n, r) => n + r.count, 0),
    done: rows.filter((r) => r.state === "done").reduce((n, r) => n + r.count, 0),
    doneToday: rows.reduce((n, r) => n + r.today, 0),
    nothing: rows.filter((r) => r.state === "nothing").reduce((n, r) => n + r.count, 0),
    usage: { input: rows.reduce((n, r) => n + r.input, 0), output: rows.reduce((n, r) => n + r.output, 0), cost: rows.reduce((n, r) => n + r.cost, 0) },
  });
  const openCards = all<Row>("SELECT * FROM cards WHERE state = 'open' ORDER BY id DESC");
  const recentCards = all<Row>("SELECT * FROM cards WHERE state <> 'open' ORDER BY id DESC LIMIT 20");
  const page = all<RunRow>(`SELECT ${COLUMNS} FROM runs ${before ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`, before ? [before, PAGE + 1] : [PAGE + 1]);
  const active = before ? [] : all<RunRow>(`SELECT ${COLUMNS} FROM runs WHERE state IN ('queued', 'claimed', 'unknown') ORDER BY id DESC`);
  const hasMore = page.length > PAGE;
  const visible = [...new Map([...page.slice(0, PAGE), ...active].map((r) => [r.id, r])).values()].sort((a, b) => b.id - a.id);
  return {
    now: iso(now),
    timezone: rules.timezone,
    totals: { ...tally(counts), attention: openCards.length },
    cards: openCards.map((c) => view(c)),
    recentCards: recentCards.map((c) => view(c)),
    sources: Object.entries(rules.sources).map(([id, s]) => ({ id, name: s.name, events: one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE source = ?", [id])!.n })),
    lines: rules.rules.map((rule) => ({
      id: rule.name, name: rule.name, group: rule.group, agent: rule.to,
      source: eventRule(rule) ? rule.when.source : "schedule",
      types: eventRule(rule) ? rule.when.types : [],
      every: eventRule(rule) ? null : describeCron(cronOf(rule)),
      next: eventRule(rule) ? null : iso(nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!),
      totals: tally(counts.filter((c) => c.rule === rule.name)),
    })),
    elsewhere: rules.elsewhere.map((task) => ({
      id: task.name, name: task.name, source: task.source, agent: task.to, cron: task.cron, every: describeCron(task.cron),
      next: iso(nextRun(parseCron(task.cron)!, now, rules.timezone) ?? now), where: task.where,
    })),
    agents: Object.entries(rules.agents).map(([id, a]) => ({
      id, name: a.name, use: a.use, worker: a.worker, seenAt: seen.get(`worker:${a.worker}`) ?? null, online: online(seen.get(`worker:${a.worker}`)),
      totals: tally(counts.filter((c) => c.agent === id)),
    })),
    channels: Object.entries(rules.channels).map(([id, c]) => ({ id, name: c.name, seenAt: seen.get(`channel:${id}`) ?? null, online: online(seen.get(`channel:${id}`)) })),
    runs: visible.map((r) => ({
      id: r.id, rule: r.rule, agent: r.agent, state: r.state, attempts: r.attempts, createdAt: r.created_at, claimedAt: r.claimed_at, finishedAt: r.finished_at, notBefore: r.not_before,
      summary: r.summary ?? "", error: r.error ?? "", link: r.link ?? "", session: r.session, usage: r.usage ? JSON.parse(r.usage) : null, stopping: r.cancel_at !== null,
      events: all<{ source: string; type: string; subject: string; summary: string; link: string }>(
        "SELECT e.source, e.type, e.subject, e.summary, e.link FROM run_events x JOIN events e ON e.id = x.event_id WHERE x.run_id = ? ORDER BY e.id DESC LIMIT 20", [r.id]),
    })),
    hasMore,
    nextBefore: hasMore ? page[PAGE - 1].id : null,
    unrouted: unrouted(),
  };
}
