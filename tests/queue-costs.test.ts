// What a long queue costs each input. Everything runs on one thread and a worker with work in hand asks every second, so
// a read that grows with the queue holds up every other request.
// Failure cases: the rules are read and parsed again for each queued run, and again for each worker; remembering them
// hides new rules from the next view or from another writer's next reader, leaks a draft's change into the view it came
// from, keeps a decision from seeing the rules it just changed, or hands a held run the current rules for its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, type View } from "../kernel/evolve.ts";
import { configuration, workerOf } from "../kernel/query.ts";
import { commit, openView } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "test-queue-costs", publicUrl: "https://hub.test" };
const fixture = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const rules = { ...fixture, rules: fixture.rules.filter((rule) => "source" in rule.when) };

/** The kernel as the shell runs it, at a fixed time. */
class Hub {
  view: View = empty();
  now = 1000;
  constructor(given = rules) {
    this.act("rules", given);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  /** Runs queued for w1, each its own subject. */
  queue(count: number, from = 0) {
    for (let n = from; n < from + count; n++)
      this.act("ingest", "app", { id: `${n}`, type: "feedback.new", subject: `#${n}` });
  }
}

/** How many times the rules are parsed while this runs, on a view nothing has read from yet. */
function rulesParsed(hub: Hub, type: string, ...args: unknown[]) {
  const fresh = evolve(hub.view, []);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (text: string, ...rest: []) => {
    if (typeof text === "string" && text.includes('"askFirst"')) parsed++;
    return parse(text, ...rest);
  };
  try {
    decide(fresh, { type, args }, hub.now, environment);
  } finally {
    JSON.parse = parse;
  }
  return parsed;
}

for (const [type, args] of [
  ["heartbeat", ["w1", []]],
  ["claimNext", ["w1", "new"]],
  ["ingest", ["app", { id: "more", type: "feedback.new", subject: "#more" }]],
  ["tick", []],
] as const) {
  test(`${type} parses the rules once, however long the queue`, () => {
    const hub = new Hub();
    hub.queue(1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
    hub.queue(49, 1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
  });
}

test("a held run's older rules are parsed once more, however many runs hold them", () => {
  const hub = new Hub();
  hub.queue(3);
  for (const n of [0, 1, 2]) hub.act("claimNext", "w1", `claim-${n}`);
  hub.act("rules", { ...rules, askFirst: ["别的"] });
  assert.equal(rulesParsed(hub, "tick"), 2);
});

test("new rules reach the next view, and a decision in flight leaves the view it came from alone", () => {
  const hub = new Hub();
  const before = hub.view;
  const was = configuration(before).askFirst;
  const decided = decide(before, { type: "rules", args: [{ ...rules, askFirst: ["别的"] }] }, 2000, environment);
  assert.deepEqual(configuration(before).askFirst, was);
  assert.deepEqual(configuration(evolve(before, decided.facts)).askFirst, ["别的"]);
});

test("a view opened after another writer changed the rules sees the new ones", () => {
  const db = new DatabaseSync(":memory:");
  const facts = (view: View, given: typeof rules) =>
    decide(view, { type: "rules", args: [given] }, 1000, environment).facts;
  const view = openView(db, "format");
  const first = commit(db, view, () => facts(view, rules));
  assert.deepEqual(configuration(first).askFirst, rules.askFirst);
  // A command writes to this database from its own process, on a view of its own.
  const other = openView(db, "format");
  commit(db, other, () => facts(other, { ...rules, askFirst: ["别的"] }));
  assert.deepEqual(configuration(openView(db, "format")).askFirst, ["别的"]);
  db.close();
});

test("a decision that changes the rules sees its own change for what it does next", () => {
  const moved = { ...rules, rules: rules.rules.map((rule) => (rule.name === "意见" ? { ...rule, to: "a2" } : rule)) };
  const hub = new Hub();
  hub.queue(1);
  const decided = decide(hub.view, { type: "rules", args: [moved] }, 2000, environment);
  const run = decided.facts[0].changes.find((change) => change.table === "runs")!.row!;
  assert.equal(run.agent, "a2");
  assert.equal(run.rules_version, decided.facts[0].seq);
});

test("a held run keeps the rules it was claimed under, read off the same view as the current ones", () => {
  const moved = { ...rules, agents: { ...rules.agents, a1: { ...rules.agents.a1, worker: "w2" } } };
  const hub = new Hub();
  hub.queue(1);
  const { run } = hub.act("claimNext", "w1", "claim");
  hub.act("rules", moved);
  const view = evolve(hub.view, []);
  assert.equal(configuration(view).agents.a1.worker, "w2");
  assert.equal(workerOf(view, view.get("runs", run)!), "w1");
  assert.equal(configuration(view).agents.a1.worker, "w2");
});
