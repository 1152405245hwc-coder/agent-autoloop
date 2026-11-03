// The cost line in `agent-autoloop status`, worked out from the runs /v1/state already lists. Failure cases: "today" is the
// machine's or UTC's day and not the rules' time zone; a price nobody reported is counted as zero, or rounds that didn't report
// are passed over in silence; a round that never started is counted, or one that's only waiting to try again; a week's worth
// of rounds is cut off at the first page of 60, or a run stuck in the queue since long ago ends the paging early.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { setup } from "./helpers.ts";
import { spendLine } from "../cli/spend.ts";
import { dayStart } from "../kernel/cron.ts";

const home = setup("status-cost");
const now = Date.parse("2026-11-03T02:00:00Z"); // 10:00 in Asia/Shanghai
const ended = (at: string, usage: object | null) => ({ claimedAt: at, finishedAt: at, usage });

test("today is the rules' day; each figure says how many rounds didn't report it", () => {
  const runs = [
    ended("2026-11-03T01:00:00Z", { input: 5000, output: 5000 }),
    ended("2026-11-03T00:30:00Z", null),
    // 01:00 on the 3rd in Shanghai: today there, though it's still the 2nd in UTC.
    ended("2026-11-02T17:00:00Z", { input: 1000, output: 234, cost: 0.5 }),
    // 18:00 on the 2nd in Shanghai: this week, not today.
    ended("2026-11-02T10:00:00Z", { input: 10000, output: 0, cost: 1 }),
    ended("2026-10-28T02:00:00Z", { input: 1, output: 1, cost: 0 }),
    // Eight days ago: past the week.
    ended("2026-10-26T02:00:00Z", { input: 999999, output: 999999, cost: 99 }),
  ];
  assert.equal(
    spendLine(runs, now, "Asia/Shanghai"),
    "今天 3 轮 · 1.1 万 Token（1 轮没上报） · $0.50（2 轮没上报）" +
      "    最近 7 天 5 轮 · 2.1 万 Token（1 轮没上报） · $1.50（2 轮没上报）",
  );
});

test("nothing reported is said to be nothing reported, not zero; nothing run is zero rounds", () => {
  const quiet = [ended("2026-11-03T01:00:00Z", null), ended("2026-11-03T01:30:00Z", {})];
  assert.equal(
    spendLine(quiet, now, "Asia/Shanghai"),
    "今天 2 轮 · Token 没上报 · 费用没上报    最近 7 天 2 轮 · Token 没上报 · 费用没上报",
  );
  assert.equal(spendLine([], now, "Asia/Shanghai"), "今天 0 轮    最近 7 天 0 轮");
});

test("only rounds that ended count: not one still going, one waiting to try again, or one stopped before it started", () => {
  const at = "2026-11-03T01:00:00Z";
  const runs = [
    { claimedAt: at, finishedAt: null, usage: null },
    { claimedAt: null, finishedAt: null, usage: { input: 5, output: 5 } },
    { claimedAt: null, finishedAt: at, usage: null },
    // Stopped while waiting to try again, after a try that did spend something.
    { claimedAt: null, finishedAt: at, usage: { input: 5, output: 5 } },
  ];
  assert.equal(
    spendLine(runs, now, "Asia/Shanghai"),
    "今天 1 轮 · 10 Token · 费用没上报    最近 7 天 1 轮 · 10 Token · 费用没上报",
  );
});

test("status reads back past the first page, and a run stuck in the queue doesn't stop it early", async () => {
  const hub = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
    hub.db.close();
  });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      owner: hub.addKey("owner", "reader"),
    }),
  );
  const clock = Date.now();
  const DAY = 86400_000;
  const round = (id: string, at: number, usage: object) => {
    hub.ingest("app", { id, type: "feedback.new", subject: id }, at);
    const job = hub.claimNext("w1", `claim-${id}`, at)!;
    hub.finish(job.run, job.token, { outcome: "done", summary: "好了", usage }, at);
  };
  // Its worker never comes: from nine days ago on it's "active", so it shows at the tail of the first page.
  hub.ingest("ops", { id: "stuck", type: "alert.raised", subject: "stuck" }, clock - 9 * DAY);
  round("old", clock - 8 * DAY, { input: 1000, output: 0, cost: 9 });
  for (let i = 0; i < 65; i++) round(`week-${i}`, clock - 3 * DAY, { input: 10, output: 0, cost: 0.01 });
  round("today", dayStart(clock, "Asia/Shanghai") + 1, { input: 100, output: 0, cost: 1 });

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), "status"],
    { env: process.env },
  );
  const lines = stdout.split("\n");
  assert.match(lines[0], /^在跑 /);
  assert.equal(lines[1], "今天 1 轮 · 100 Token · $1.00    最近 7 天 66 轮 · 750 Token · $1.65");
});
