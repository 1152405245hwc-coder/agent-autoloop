// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import type { Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";

export const configuration = (view: View) => view.tables.config.rules?.value as Rules;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set(Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker));

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, agents: string[], now: number) {
  const ready = (run: Row) => run.state === "queued" && Date.parse(run.not_before) <= now;
  return rows(view, "runs").filter((run) => agents.includes(run.agent) && (run.state === "claimed" || ready(run)));
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events").filter((link) => link.run_id === runId);
  return links.map((link) => view.tables.events[link.event_id]).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  const inScope = (card: Row) => card.grp === run.grp && card.source === source && card.created_at <= run.claimed_at;
  return rows(view, "cards").filter((card) => card.state === "open" && inScope(card));
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...when,
  };
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view);
  const { name, cwd, skill, prompt, emits } = rules.rules.find((rule) => rule.name === run.rule)!;
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const cards = rows(view, "cards");
  const timers = rows(view, "timers");
  const answers = cards.filter((card) => eventIds.includes(card.answer_event));
  const sameThread = (row: Row) => row.rule === run.rule && row.lane === run.lane;
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    rule: { name, cwd, skill, prompt, emits },
    agent: { ...rules.agents[run.agent], id: run.agent },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        return { card, title, options: JSON.parse(options), choice, text, about, by, at };
      }),
      timers: timers.filter((timer) => eventIds.includes(timer.event_id)).map(timerView),
      waiting: timers
        .filter((timer) => sameThread(timer) && timer.event_id === null)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: cards
        .filter((card) => sameThread(card) && ["decided", "done"].includes(card.state))
        .reverse()
        .slice(0, 20)
        .filter((card) => !answers.includes(card))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  const agents = agentsOf(view, worker);
  const stopping = (run: Row) => run.state === "claimed" && run.cancel_at !== null && agents.includes(run.agent);
  return rows(view, "runs")
    .filter(stopping)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  const events = rows(view, "events").filter((event) => event.routed === "[]");
  return events.reverse().slice(0, limit);
}

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });
