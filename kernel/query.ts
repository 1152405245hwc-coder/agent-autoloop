import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { rows, type Row, type View, type Fact } from "./evolve.ts";
import type { Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";

export type Environment = { secret: string; publicUrl: string };
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const credential = (env: Environment, purpose: string, ...parts: unknown[]) => createHmac("sha256", env.secret).update(JSON.stringify([purpose, ...parts])).digest("base64url");
export const configuration = (v: View) => v.tables.config.rules?.value as Rules;
export const agentsOf = (v: View, worker: string) => Object.entries(configuration(v).agents).filter(([, a]) => a.worker === worker).map(([id]) => id);
export const eventsOf = (v: View, id: number) => rows(v, "run_events").filter(e => e.run_id === id).map(e => v.tables.events[e.event_id]).sort((a,b) => a.id-b.id);
export const sourceOf = (v: View, id: number) => { const s = [...new Set(eventsOf(v, id).map(e => e.source))]; return s.length === 1 ? s[0] : null; };
export function openInScope(v: View, run: Row) {
  const source = sourceOf(v, run.id);
  return source && run.claimed_at ? rows(v, "cards").filter(c => c.state === "open" && c.grp === run.grp && c.source === source && c.created_at <= run.claimed_at) : [];
}
export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  return {
    id: card.id as number, version: card.version as number, ref, kind: card.kind as string, state: card.state as string, title: card.title as string, text: card.text as string,
    options: card.kind === "ask" ? JSON.parse(card.options) as string[] : card.state === "open" ? ["已处理"] : [],
    recommend: card.recommend as number | null, choice: card.choice as number | null, answer: card.answer as string | null, by: card.by as string | null, result: card.result as string | null,
    link: links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", card.id, card.created_at)}` : null,
    rule: card.rule, createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at,
  };
}
export function jobOf(v: View, row: Row, env: Environment): Job {
  const rules = configuration(v), rule = rules.rules.find(r => r.name === row.rule)!, agent = rules.agents[row.agent];
  const events = eventsOf(v, row.id), ids = events.map(e => e.id);
  const answers = rows(v, "cards").filter(c => ids.includes(c.answer_event));
  return {
    run: row.id, token: credential(env, "run", row.id, row.issued), attempt: row.attempts + 1,
    rule: { name: rule.name, cwd: rule.cwd, skill: rule.skill, prompt: rule.prompt, emits: rule.emits },
    agent: { ...agent, id: row.agent }, session: row.session ?? row.resume, askFirst: rules.askFirst,
    context: {
      events: events.map(e => ({ id: e.key, source: e.source, sourceName: rules.sources[e.source]?.name ?? e.source, type: e.type, subject: e.subject, summary: e.summary, detail: e.detail, link: e.link, receivedAt: e.received_at,hops:e.hops??0 })),
      answers: answers.map(c => ({ card: c.id, title: c.title, options: JSON.parse(c.options), choice: c.choice, text: c.answer, about: c.about, by: c.by, at: c.decided_at })),
      timers: rows(v, "timers").filter(t => ids.includes(t.event_id)).map(t => ({ key: t.key, about: t.about, at: t.at })),
      waiting: rows(v, "timers").filter(t => t.rule === row.rule && t.lane === row.lane && t.event_id === null).sort((a,b) => a.at.localeCompare(b.at)).map(t => ({ key: t.key, about: t.about, at: t.at })),
      open: openInScope(v, row).map(c => ({ card: c.id, title: c.title, text: c.text, at: c.created_at })),
      decided: rows(v, "cards").filter(c => c.rule === row.rule && c.lane === row.lane && ["decided", "done"].includes(c.state)).reverse().slice(0,20).filter(c => !answers.includes(c)).map(c => ({ card: c.id, title: c.title, choice: c.choice === null ? c.answer : JSON.parse(c.options)[c.choice], at: c.decided_at })),
    },
  };
}
export function whose(v: View, kind: string, key: string): string | null {
  if (!key) return null;
  const given = Buffer.from(digest(key), "hex");
  return rows(v, "keys").find(k => k.kind === kind && timingSafeEqual(Buffer.from(k.hash, "hex"), given))?.name ?? null;
}
export const cancels = (v: View, worker: string): number[] => rows(v, "runs").filter(r => r.state === "claimed" && r.cancel_at !== null && agentsOf(v,worker).includes(r.agent)).map(r => r.id);
export const unrouted = (v: View, limit = 20) => rows(v, "events").filter(e => e.routed === "[]").reverse().slice(0, limit);
export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter((c: Row) => c.table !== "keys") });
