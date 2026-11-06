// Naming a run: `stop` and `why` with no number, or with a word that is not one, used to send /v1/runs/NaN to the hub and
// print "没有这个地址", which reads like a broken hub rather than a mistyped command. Found here by running the real program in a home nothing is installed into: the usage must come before any hub is asked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-run-id-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "home") } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

for (const args of [
  ["stop"],
  ["stop", "abc"],
  ["stop", "0"],
  ["stop", "1.5"],
  ["why"],
  ["why", "--json"],
  ["why", "x"],
]) {
  test(`${args.join(" ")} says how to name a run instead of asking the hub`, async () => {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, new RegExp(`用法：agent-autoloop ${args[0]} <第几轮>`));
  });
}

test("a real run number still goes on to the hub", async () => {
  for (const args of [
    ["stop", "3"],
    ["why", "3", "--json"],
    ["why", "--json", "3"],
  ]) {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.doesNotMatch(ran.stderr, /用法/);
    assert.match(ran.stderr, /还没装好/);
  }
});
