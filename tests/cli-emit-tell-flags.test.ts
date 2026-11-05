// Flags on `emit` and `tell`: a misspelt `emit pr --dryrun` used to drop the flag in silence and send the event for real,
// waking whatever Agent a rule hands it to; a misspelt `tell 7 --tsk nightly` sent as the source instead of the task.
// Found here by running the real program in a home nothing is installed into: the stop must come before the config is read.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-emit-tell-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]) {
  const child = promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", program, ...args], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "home") },
  });
  child.child.stdin?.end("hello");
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("emit with a misspelt --dry-run stops instead of sending", async () => {
  const ran = await run(["emit", "pr", "--dryrun"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--dryrun/);
});

test("emit --help says how to use it", async () => {
  const ran = await run(["emit", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop emit <类型>/);
});

test("tell with a misspelt --task stops instead of sending as the source", async () => {
  const ran = await run(["tell", "7", "--tsk", "nightly"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--tsk/);
});

test("tell --help says how to use it", async () => {
  const ran = await run(["tell", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop tell <编号>/);
});

test("the flags emit and tell do read still go on to the config", async () => {
  for (const args of [
    ["emit", "pr", "--subject", "7", "--summary", "s", "--detail", "d", "--link", "l", "--id", "i", "--key", "k"],
    ["emit", "pr", "--dry-run"],
    ["tell", "7", "--task", "nightly"],
  ]) {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.doesNotMatch(ran.stderr, /不认识的参数/);
    assert.match(ran.stderr, /还没装好/);
  }
});
