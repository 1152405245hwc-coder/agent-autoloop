// Everything this machine does, in one process: the hub, the worker and its channels, whichever config.json says. They
// speak the same protocol to each other here as they would across the world. A stop leaves agents running: they're detached,
// and the worker finds them again when it's back.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadChannel } from "./channels.ts";
import { hubClient } from "./client.ts";
import { readConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);

/** The version running: what was deployed, or the checkout's commit. */
export function commitOf() {
  if (process.env.AGENT_HUB_COMMIT) return process.env.AGENT_HUB_COMMIT;
  const root = path.join(import.meta.dirname, "..");
  try {
    const head = readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: ") ? readFileSync(path.join(root, ".git", head.slice(5)), "utf8").trim() : head;
  } catch {
    return "dev";
  }
}

/** Only one of these per install: a second would take work beside the first. */
function lock() {
  const file = path.join(HOME, "up.pid");
  if (existsSync(file)) {
    const pid = readFileSync(file, "utf8").trim();
    let command = "";
    try {
      command = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
    } catch {}
    if (command.includes("agent-hub")) throw new Error(`已经在跑了（进程 ${pid}）`);
  }
  writeFileSync(file, String(process.pid));
  return () => { try { unlinkSync(file); } catch {} };
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export async function up() {
  const config = readConfig();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const unlock = lock();
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  if (config.hub) {
    loadSecrets();
    const [host, port] = config.hub.listen.split(":");
    process.env.AGENT_HUB_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    const server = serve(Number(port), host, { commit: commitOf() });
    server.on("listening", () => say(`listening on ${config.hub!.listen}`));
    server.on("error", (error) => { say(`can't listen: ${error}`); process.exit(1); });
    close = () => { server.close(); server.closeAllConnections(); };
  }
  if (config.worker) {
    const { key, name, capacity, unreachable } = config.worker;
    jobs.push(createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: log("worker") }).run(stop.signal));
  }
  for (const [id, { use, key, ...options }] of Object.entries(config.channels ?? {})) {
    const say = log(id);
    jobs.push((async () => {
      while (!stop.signal.aborted) {
        try {
          const start = await loadChannel(use ?? id);
          await start({ hub: hubClient(config.url, key), options, log: say, signal: stop.signal });
        } catch (error) {
          say(`stopped: ${error}; starting again in 30 seconds`);
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      }
    })());
  }
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  await Promise.all(jobs);
}
